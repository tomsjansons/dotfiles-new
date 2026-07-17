import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

import SuperJSON from "superjson";
import { stringify as stringifyYaml } from "yaml";

const pendingRpc = new Map();
let nextRpcId = 0;

class ConsoleUnavailableError extends Error {
  constructor(property) {
    super(`console.${String(property)} is unavailable in JavaScript jobs. Return data explicitly, for example: return value`);
    this.name = "ConsoleUnavailableError";
    this.code = "ERR_JOB_CONSOLE_UNAVAILABLE";
  }
}

function unavailableConsole() {
  const fail = (property) => {
    throw new ConsoleUnavailableError(property);
  };
  return new Proxy(Object.create(null), {
    get: (_target, property) => fail(property),
    set: (_target, property) => fail(property),
    has: (_target, property) => fail(property),
    ownKeys: () => fail("[[OwnPropertyKeys]]"),
    getOwnPropertyDescriptor: (_target, property) => fail(property),
    defineProperty: (_target, property) => fail(property),
  });
}

function rpc(method, args) {
  const id = `rpc-${++nextRpcId}`;
  return new Promise((resolve, reject) => {
    pendingRpc.set(id, { resolve, reject });
    process.send?.({ kind: "rpc_request", id, method, args });
  });
}

function normalizedError(error, phase = "execution") {
  if (error instanceof Error || (error && typeof error === "object")) {
    const value = error;
    return {
      phase,
      name: typeof value.name === "string" ? value.name : "Error",
      code: typeof value.code === "string" ? value.code : "ERR_JOB_EXECUTION",
      message: typeof value.message === "string" ? value.message : String(value),
      stack: typeof value.stack === "string" ? value.stack : undefined,
      cause: value.cause === undefined ? undefined : safeCause(value.cause),
    };
  }
  return {
    phase,
    name: "NonErrorThrow",
    code: "ERR_JOB_NON_ERROR_THROW",
    message: String(error),
    cause: error,
  };
}

function safeCause(value) {
  try {
    return SuperJSON.serialize(value);
  } catch {
    return String(value);
  }
}

function assertSupported(value, seen = new Set(), path = "$", depth = 0) {
  if (depth > 1_000) throw resultError(path, "value nesting is too deep");
  const kind = typeof value;
  if (kind === "function" || kind === "symbol") throw resultError(path, `${kind} values are unsupported`);
  if (value === null || kind !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  const tag = Object.prototype.toString.call(value);
  if (["[object Date]", "[object RegExp]", "[object Error]", "[object URL]", "[object ArrayBuffer]"].includes(tag) || ArrayBuffer.isView(value)) return;
  if (tag === "[object Map]") {
    let index = 0;
    for (const [key, entry] of value) {
      assertSupported(key, seen, `${path}.<map-key-${index}>`, depth + 1);
      assertSupported(entry, seen, `${path}.<map-value-${index}>`, depth + 1);
      index += 1;
    }
    return;
  }
  if (tag === "[object Set]") {
    let index = 0;
    for (const entry of value) assertSupported(entry, seen, `${path}.<set-${index++}>`, depth + 1);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSupported(entry, seen, `${path}[${index}]`, depth + 1));
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype?.constructor?.name !== "Object") {
    throw resultError(path, `unregistered class instance ${prototype?.constructor?.name ?? "unknown"} is unsupported`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") throw resultError(path, "symbol keys are unsupported");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) assertSupported(descriptor.value, seen, `${path}.${key}`, depth + 1);
  }
}

function resultError(path, message) {
  const error = new Error(`Cannot serialize result at ${path}: ${message}`);
  error.name = "JobResultNotSerializableError";
  error.code = "ERR_JOB_RESULT_NOT_SERIALIZABLE";
  return error;
}

function normalizeRealm(value, seen = new Map()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  const tag = Object.prototype.toString.call(value);
  if (tag === "[object Date]") return new Date(value.getTime());
  if (tag === "[object RegExp]") return new RegExp(value.source, value.flags);
  if (tag === "[object URL]") return new URL(value.href);
  if (tag === "[object ArrayBuffer]" || ArrayBuffer.isView(value)) return structuredClone(value);
  if (tag === "[object Error]") {
    const output = new Error(value.message);
    seen.set(value, output);
    output.name = value.name;
    output.stack = value.stack;
    if (value.cause !== undefined) output.cause = normalizeRealm(value.cause, seen);
    return output;
  }
  if (tag === "[object Map]") {
    const output = new Map();
    seen.set(value, output);
    for (const [key, entry] of value) output.set(normalizeRealm(key, seen), normalizeRealm(entry, seen));
    return output;
  }
  if (tag === "[object Set]") {
    const output = new Set();
    seen.set(value, output);
    for (const entry of value) output.add(normalizeRealm(entry, seen));
    return output;
  }
  if (Array.isArray(value)) {
    const output = [];
    seen.set(value, output);
    for (let index = 0; index < value.length; index += 1) {
      if (Object.hasOwn(value, index)) output[index] = normalizeRealm(value[index], seen);
    }
    return output;
  }
  const output = Object.create(Object.getPrototypeOf(value) === null ? null : Object.prototype);
  seen.set(value, output);
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) output[key] = normalizeRealm(descriptor.value, seen);
  }
  return output;
}

function toYaml(value) {
  assertSupported(value);
  return stringifyYaml(SuperJSON.serialize(normalizeRealm(value)), { lineWidth: 120 });
}

function importResolver(cwd) {
  const require = createRequire(resolve(cwd, "__pi_job__.mjs"));
  return async (specifier) => {
    if (specifier.startsWith("node:") || specifier.startsWith("data:") || specifier.startsWith("file:")) {
      return import(specifier);
    }
    if (isAbsolute(specifier)) return import(pathToFileURL(specifier).href);
    if (specifier.startsWith(".")) return import(pathToFileURL(resolve(cwd, specifier)).href);
    return import(pathToFileURL(require.resolve(specifier)).href);
  };
}

async function run(message) {
  const sourcePath = message.sourcePath;
  const sandbox = {
    job: (args) => rpc("job", args),
    job_list: (args = {}) => rpc("job_list", args),
    job_stop: (args) => rpc("job_stop", args),
    console: unavailableConsole(),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    fetch: globalThis.fetch?.bind(globalThis),
    Headers: globalThis.Headers,
    Request: globalThis.Request,
    Response: globalThis.Response,
    FormData: globalThis.FormData,
    URL: globalThis.URL,
    URLSearchParams: globalThis.URLSearchParams,
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
    AbortController: globalThis.AbortController,
    AbortSignal: globalThis.AbortSignal,
  };
function finish(message, exitCode) {
  if (process.connected && process.send) {
    process.send(message, () => process.exit(exitCode));
    setTimeout(() => process.exit(exitCode), 1_000).unref();
  } else {
    process.exit(exitCode);
  }
}

  const context = vm.createContext(sandbox, { name: `pi-job:${message.jobId}` });
  const wrapped = `(async () => {\n${message.cmd}\n})()`;
  try {
    const script = new vm.Script(wrapped, {
      filename: sourcePath,
      lineOffset: -1,
      importModuleDynamically: importResolver(message.cwd),
    });
    const value = await script.runInContext(context);
    finish({ kind: "terminal", status: "completed", outputYaml: toYaml(value) }, 0);
  } catch (error) {
    const normalized = normalizedError(error, error?.code === "ERR_JOB_RESULT_NOT_SERIALIZABLE" ? "serialization" : "execution");
    let outputYaml;
    try {
      outputYaml = stringifyYaml(SuperJSON.serialize({ error: normalized }), { lineWidth: 120 });
    } catch {
      outputYaml = `json:\n  error:\n    code: ERR_JOB_FAILURE_SERIALIZATION\n    message: ${JSON.stringify(normalized.message)}\n`;
    }
    finish({ kind: "terminal", status: "failed", error: normalized, outputYaml }, 1);
  }
}

process.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (message.kind === "run") void run(message);
  if (message.kind === "rpc_response") {
    const pending = pendingRpc.get(message.id);
    if (!pending) return;
    pendingRpc.delete(message.id);
    if (message.ok) pending.resolve(message.value);
    else {
      const error = new Error(message.error?.message ?? "Job RPC failed");
      Object.assign(error, message.error ?? {});
      pending.reject(error);
    }
  }
});

process.on("disconnect", () => process.exit(1));
process.send?.({ kind: "ready" });
