import { isAbsolute } from "node:path";

export const RUNNER_REQUEST_ERROR_CODE = "ERR_HERDR_RUNNER_REQUEST_INVALID";

export class RunnerRequestProtocolError extends Error {
  /**
   * @param {string} field
   * @param {string} requirement
   */
  constructor(field, requirement) {
    super(`Invalid Herdr runner request: ${field} ${requirement}`);
    this.name = "RunnerRequestProtocolError";
    this.code = RUNNER_REQUEST_ERROR_CODE;
    this.field = field;
  }
}

const REQUEST_FIELDS = new Set(["id", "cmd", "cwd", "outputPath", "resultPath", "env"]);

/** @param {string} field @param {unknown} value */
function requireString(field, value) {
  if (typeof value !== "string") throw new RunnerRequestProtocolError(field, "must be a string");
  return value;
}

/** @param {string} field @param {unknown} value */
function requireAbsolutePath(field, value) {
  const path = requireString(field, value);
  if (path.length === 0) throw new RunnerRequestProtocolError(field, "must not be empty");
  if (path.includes("\0")) throw new RunnerRequestProtocolError(field, "must not contain NUL");
  if (!isAbsolute(path)) throw new RunnerRequestProtocolError(field, "must be an absolute path");
  return path;
}

/**
 * Validate an untrusted value at the host/runner protocol boundary. The command
 * is deliberately checked only for its type and is returned unchanged.
 *
 * @param {unknown} value
 * @returns {import("./runner-protocol.mjs").RunnerRequest}
 */
export function validateRunnerRequest(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RunnerRequestProtocolError("request", "must be an object");
  }

  for (const field of Object.keys(value)) {
    if (!REQUEST_FIELDS.has(field)) throw new RunnerRequestProtocolError(field, "is not supported");
  }

  const request = /** @type {Record<string, unknown>} */ (value);
  const id = requireString("id", request.id);
  if (id.length === 0) throw new RunnerRequestProtocolError("id", "must not be empty");
  if (id.includes("\0")) throw new RunnerRequestProtocolError("id", "must not contain NUL");

  requireString("cmd", request.cmd);
  requireAbsolutePath("cwd", request.cwd);
  const outputPath = requireAbsolutePath("outputPath", request.outputPath);
  const resultPath = requireAbsolutePath("resultPath", request.resultPath);
  if (resultPath === outputPath) throw new RunnerRequestProtocolError("resultPath", "must differ from outputPath");

  if (
    typeof request.env !== "object"
    || request.env === null
    || Array.isArray(request.env)
    || (Object.getPrototypeOf(request.env) !== Object.prototype && Object.getPrototypeOf(request.env) !== null)
  ) {
    throw new RunnerRequestProtocolError("env", "must be an object of string values");
  }
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, envValue] of Object.entries(request.env)) {
    if (key.length === 0 || key.includes("=") || key.includes("\0")) {
      throw new RunnerRequestProtocolError("env", "contains an invalid variable name");
    }
    if (typeof envValue !== "string") {
      throw new RunnerRequestProtocolError("env", "must contain only string values");
    }
    if (envValue.includes("\0")) throw new RunnerRequestProtocolError("env", "values must not contain NUL");
    Object.defineProperty(env, key, { value: envValue, enumerable: true, writable: true, configurable: true });
  }

  return {
    id,
    cmd: /** @type {string} */ (request.cmd),
    cwd: /** @type {string} */ (request.cwd),
    outputPath,
    resultPath,
    env,
  };
}

/**
 * @param {string} text
 * @returns {import("./runner-protocol.mjs").RunnerRequest}
 */
export function parseRunnerRequestJson(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new RunnerRequestProtocolError("request", "must be valid JSON");
  }
  return validateRunnerRequest(value);
}
