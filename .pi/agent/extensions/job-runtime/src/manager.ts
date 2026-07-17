import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  appendEvent,
  atomicWrite,
  jobArtifactDir,
  persistManifest,
  persistResult,
  publicRecord,
  truncateMiddle,
} from "./artifacts.ts";
import { JobProviderRegistry } from "./providers.ts";
import type {
  CompletionDelivery,
  JobInvocationContext,
  JobListInput,
  JobListResult,
  JobSnapshot,
  JobStartInput,
  JobStopInput,
  MutableJobRecord,
  NormalizedJobError,
  ProviderTerminalResult,
} from "./types.ts";

const GLOBAL_MANAGER = Symbol.for("dotfiles.piJobs.manager.v1");
const HISTORY_PAGE_SIZE = 50;

function snapshot(record: MutableJobRecord): JobSnapshot {
  const { cmd: _cmd, handle: _handle, completion: _completion, deliveryState: _delivery, rootToolCallId: _tool, sessionPath: _path, ...value } = record;
  return structuredClone(value);
}

function normalizeError(error: unknown, phase = "bootstrap", fallbackCode = "ERR_JOB_PROVIDER"): NormalizedJobError {
  if (error instanceof Error) {
    return {
      phase,
      name: error.name,
      code: typeof (error as any).code === "string" ? (error as any).code : fallbackCode,
      message: error.message,
      stack: error.stack,
      cause: (error as any).cause,
    };
  }
  return { phase, name: "Error", code: fallbackCode, message: String(error) };
}

function errorWithCode(code: string, message: string): Error {
  const error = new Error(message);
  error.name = "JobError";
  (error as any).code = code;
  return error;
}

function cursorFor(record: JobSnapshot): string {
  return Buffer.from(JSON.stringify([record.endedAt ?? "", record.id])).toString("base64url");
}

function parseCursor(cursor: string | undefined): [string, string] | undefined {
  if (!cursor) return undefined;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(value) && value.length === 2 && value.every((part) => typeof part === "string")) return value as [string, string];
  } catch {
    // Normalized below.
  }
  throw errorWithCode("ERR_JOB_LIST_CURSOR", "Invalid job_list cursor");
}

export class JobManager {
  readonly providers = new JobProviderRegistry();
  readonly #records = new Map<string, MutableJobRecord>();
  readonly #closedLineages = new Set<string>();
  #deliveryHandler?: (delivery: CompletionDelivery) => Promise<void> | void;
  #pendingDeliveries: CompletionDelivery[] = [];
  readonly #suppressedDeliverySessions = new Set<string>();

  setDeliveryHandler(handler: ((delivery: CompletionDelivery) => Promise<void> | void) | undefined): void {
    this.#deliveryHandler = handler;
    if (!handler || this.#pendingDeliveries.length === 0) return;
    const pending = this.#pendingDeliveries;
    this.#pendingDeliveries = [];
    for (const delivery of pending) void this.#deliver(delivery);
  }

  async start(
    input: JobStartInput,
    context: JobInvocationContext,
    signal?: AbortSignal,
    onStarted?: (job: JobSnapshot) => void,
  ): Promise<JobSnapshot> {
    this.#validateInput(input);
    const mode = input.mode ?? "sync";
    const provider = this.providers.get(input.type);
    if (!provider) throw errorWithCode("ERR_JOB_TYPE_UNAVAILABLE", `Job type ${JSON.stringify(input.type)} is unavailable`);
    if (context.parentJobId && this.#lineageIsClosed(context.parentJobId)) {
      throw errorWithCode("ERR_JOB_PARENT_CLOSING", `Parent job ${context.parentJobId} is terminating and cannot start children`);
    }

    const now = new Date();
    const id = `job-${crypto.randomUUID()}`;
    const parent = context.parentJobId ? this.#records.get(context.parentJobId) : undefined;
    if (context.parentJobId && !parent) throw errorWithCode("ERR_JOB_PARENT_UNKNOWN", `Unknown parent job ${context.parentJobId}`);
    const artifactDir = jobArtifactDir({
      cwd: context.cwd,
      sessionId: context.sessionId,
      sessionTimestamp: context.sessionTimestamp ?? now.toISOString(),
      jobId: id,
      jobTimestamp: now.toISOString(),
    });
    const outputPath = join(artifactDir, input.type === "js" ? "output.yaml" : "output.log");
    const record: MutableJobRecord = {
      id,
      type: input.type,
      mode,
      status: "starting",
      cmd: input.cmd,
      cwd: context.cwd,
      sessionId: context.sessionId,
      sessionPath: context.sessionPath,
      parentJobId: context.parentJobId,
      rootJobId: parent?.rootJobId ?? id,
      rootToolCallId: parent?.rootToolCallId ?? context.rootToolCallId,
      artifactDir,
      outputPath,
      startedAt: now.toISOString(),
      deliveryState: "none",
    };
    this.#records.set(id, record);

    await mkdir(artifactDir, { recursive: true });
    if (input.type === "js") await atomicWrite(join(artifactDir, "source.js"), input.cmd);
    else await atomicWrite(join(artifactDir, "request.json"), `${JSON.stringify({ cmd: input.cmd, cwd: context.cwd }, null, 2)}\n`);
    await appendEvent(artifactDir, { type: "state", status: "starting", at: now.toISOString() });
    await persistManifest(record);

    try {
      record.handle = await provider.start(
        { type: input.type, cmd: input.cmd, mode, timeout: input.timeout },
        {
          record,
          invoke: (method, args) => this.#invokeNested(record, method, args),
        },
      );
    } catch (error) {
      const normalized = normalizeError(error, "bootstrap", "ERR_JOB_LAUNCH");
      record.status = "failed";
      record.error = normalized;
      record.endedAt = new Date().toISOString();
      record.durationMs = Date.parse(record.endedAt) - Date.parse(record.startedAt);
      await appendEvent(artifactDir, { type: "launch_error", at: record.endedAt, error: normalized });
      await persistResult(record);
      throw error;
    }

    record.status = "running";
    await appendEvent(artifactDir, { type: "state", status: "running", at: new Date().toISOString() });
    await persistManifest(record);
    record.completion = this.#complete(record, record.handle.completion);
    onStarted?.(snapshot(record));

    const onAbort = () => void this.stop({ id }, "tool_abort");
    if (signal?.aborted) onAbort();
    else if (signal && mode === "sync") {
      signal.addEventListener("abort", onAbort, { once: true });
      record.completion.finally(() => signal.removeEventListener("abort", onAbort)).catch(() => undefined);
    }

    if (mode === "async") return snapshot(record);
    return record.completion;
  }

  list(input: JobListInput = {}, sessionId?: string): JobListResult {
    const typeMatches = (record: MutableJobRecord) => !input.type || record.type === input.type;
    const running = [...this.#records.values()]
      .filter((record) => record.status === "starting" || record.status === "running")
      .filter(typeMatches)
      .map(snapshot)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const terminal = [...this.#records.values()]
      .filter((record) => record.status !== "starting" && record.status !== "running")
      .filter((record) => !sessionId || record.sessionId === sessionId)
      .filter(typeMatches)
      .map(snapshot)
      .sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? "") || b.id.localeCompare(a.id));

    const include = input.include ?? "running";
    if (include === "running") return { running, nonRunningCount: terminal.length };
    const cursor = parseCursor(input.cursor);
    let start = 0;
    if (cursor) {
      const index = terminal.findIndex((record) => record.endedAt === cursor[0] && record.id === cursor[1]);
      if (index < 0) throw errorWithCode("ERR_JOB_LIST_CURSOR", "job_list cursor no longer identifies a retained job");
      start = index + 1;
    }
    const page = terminal.slice(start, start + HISTORY_PAGE_SIZE);
    const nextCursor = start + page.length < terminal.length && page.length > 0 ? cursorFor(page.at(-1)!) : undefined;
    return {
      running: include === "all" ? running : [],
      nonRunningCount: terminal.length,
      nonRunning: page,
      nextCursor,
    };
  }

  async stop(input: JobStopInput, reason = "stopped"): Promise<JobSnapshot> {
    const record = this.#records.get(input.id);
    if (!record) throw errorWithCode("ERR_JOB_NOT_FOUND", `Unknown job ${input.id}`);
    if (record.status !== "starting" && record.status !== "running") return snapshot(record);
    this.#closedLineages.add(record.id);
    const descendants = this.#activeDescendants(record.id);
    await Promise.allSettled(descendants.map((child) => child.handle?.stop(`parent_${reason}`)));
    await record.handle?.stop(reason);
    await Promise.allSettled(descendants.map((child) => child.completion));
    return record.completion ? await record.completion : snapshot(record);
  }

  async stopSession(sessionId: string, reason: string): Promise<void> {
    this.#suppressedDeliverySessions.add(sessionId);
    this.#pendingDeliveries = this.#pendingDeliveries.filter((delivery) => delivery.job.sessionId !== sessionId);
    const roots = [...this.#records.values()].filter(
      (record) => record.sessionId === sessionId && !record.parentJobId && (record.status === "starting" || record.status === "running"),
    );
    await Promise.allSettled(roots.map((record) => this.stop({ id: record.id }, reason)));
  }

  get(id: string): JobSnapshot | undefined {
    const record = this.#records.get(id);
    return record ? snapshot(record) : undefined;
  }

  async #invokeNested(parent: MutableJobRecord, method: "job" | "job_list" | "job_stop", args: unknown): Promise<unknown> {
    if (method === "job") {
      return this.start(args as JobStartInput, {
        cwd: parent.cwd,
        sessionId: parent.sessionId,
        sessionPath: parent.sessionPath,
        sessionTimestamp: parent.startedAt,
        parentJobId: parent.id,
        rootToolCallId: parent.rootToolCallId,
      });
    }
    if (method === "job_list") return this.list((args ?? {}) as JobListInput, parent.sessionId);
    const stopInput = args as JobStopInput;
    if (stopInput?.id === parent.id) throw errorWithCode("ERR_JOB_STOP_SELF", "A JavaScript job cannot synchronously stop itself");
    return this.stop(stopInput);
  }

  async #complete(record: MutableJobRecord, providerCompletion: Promise<ProviderTerminalResult>): Promise<JobSnapshot> {
    let terminal: ProviderTerminalResult;
    try {
      terminal = await providerCompletion;
    } catch (error) {
      const normalized = normalizeError(error, "provider", "ERR_JOB_PROVIDER_COMPLETION");
      terminal = { status: "failed", outputPath: record.outputPath, error: normalized };
    }

    if (terminal.status !== "completed") {
      this.#closedLineages.add(record.id);
      const descendants = this.#activeDescendants(record.id);
      await Promise.allSettled(descendants.map((child) => child.handle?.stop(`parent_${terminal.status}`)));
      await Promise.allSettled(descendants.map((child) => child.completion));
    }

    if (terminal.outputText !== undefined) {
      if (!terminal.outputPersisted) await atomicWrite(record.outputPath, terminal.outputText);
      const truncated = truncateMiddle(terminal.outputText);
      record.output = truncated.text;
      record.outputTruncated = truncated.truncated;
      record.totalOutputLines = truncated.totalLines;
      record.totalOutputBytes = truncated.totalBytes;
    }
    record.status = terminal.status;
    record.exitCode = terminal.exitCode;
    record.signal = terminal.signal;
    record.error = terminal.error;
    record.stopReason = terminal.stopReason;
    record.endedAt = new Date().toISOString();
    record.durationMs = Date.parse(record.endedAt) - Date.parse(record.startedAt);
    await appendEvent(record.artifactDir, { type: "state", status: record.status, at: record.endedAt });
    await persistManifest(record);
    await persistResult(record);

    const value = snapshot(record);
    if (!record.parentJobId && record.mode === "async" && !this.#suppressedDeliverySessions.has(record.sessionId)) {
      record.deliveryState = "pending";
      const delivery = { job: value, content: this.#completionContent(value) };
      if (this.#deliveryHandler) void this.#deliver(delivery);
      else this.#pendingDeliveries.push(delivery);
    }
    return value;
  }

  async #deliver(delivery: CompletionDelivery): Promise<void> {
    if (!this.#deliveryHandler) {
      this.#pendingDeliveries.push(delivery);
      return;
    }
    const record = this.#records.get(delivery.job.id);
    if (!record || record.deliveryState === "delivered") return;
    try {
      await this.#deliveryHandler(delivery);
      record.deliveryState = "delivered";
      await persistManifest(record);
    } catch {
      if (!this.#pendingDeliveries.some((pending) => pending.job.id === delivery.job.id)) this.#pendingDeliveries.push(delivery);
    }
  }

  #completionContent(job: JobSnapshot): string {
    const lines = [
      `Async ${job.type} job ${job.id} ${job.status} in ${((job.durationMs ?? 0) / 1_000).toFixed(1)}s.`,
    ];
    if (job.output) lines.push("", job.output);
    lines.push("", `Full output: ${job.outputPath}`);
    return lines.join("\n");
  }

  #lineageIsClosed(parentId: string): boolean {
    let current: string | undefined = parentId;
    while (current) {
      if (this.#closedLineages.has(current)) return true;
      current = this.#records.get(current)?.parentJobId;
    }
    return false;
  }
  #validateInput(input: JobStartInput): void {
    if (!input || typeof input !== "object") throw errorWithCode("ERR_JOB_INPUT", "job input must be an object");
    if (input.type !== "js" && input.type !== "bash") throw errorWithCode("ERR_JOB_INPUT", "job.type must be js or bash");
    if (typeof input.cmd !== "string") throw errorWithCode("ERR_JOB_INPUT", "job.cmd must be a string");
    if (input.mode !== undefined && input.mode !== "sync" && input.mode !== "async") {
      throw errorWithCode("ERR_JOB_INPUT", "job.mode must be sync or async");
    }
    if (input.timeout !== undefined && (!Number.isFinite(input.timeout) || input.timeout <= 0)) {
      throw errorWithCode("ERR_JOB_INPUT", "job.timeout must be a positive number of seconds");
    }
  }


  #activeDescendants(parentId: string): MutableJobRecord[] {
    return [...this.#records.values()].filter((record) => {
      if (record.status !== "starting" && record.status !== "running") return false;
      let current = record.parentJobId;
      while (current) {
        if (current === parentId) return true;
        current = this.#records.get(current)?.parentJobId;
      }
      return false;
    });
  }
}

export function getGlobalJobManager(): JobManager {
  const global = globalThis as any;
  return (global[GLOBAL_MANAGER] ??= new JobManager());
}
