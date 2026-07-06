import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { rmSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const STATUS_DIR = "~/.pi/agent/zellij-status";
const PID = process.pid;

type TitleSource = "none" | "sessionName" | "summary";
type PiState = "starting" | "running" | "idle" | "asking" | "compacting" | "error";

interface PiZellijStatus {
  pid: number;
  title: string;
  titleSource: TitleSource;
  sessionName?: string;
  sessionId?: string;
  sessionFile?: string;
  cwd: string;
  state: PiState;
  isStreaming: boolean;
  isCompacting: boolean;
  currentTool?: string;
  turnCount: number;
  startedAt: number;
  lastOutputAt: number;
  lastAgentEndAt?: number;
  updatedAt: number;
}

let status: PiZellijStatus | undefined;
let previousState: PiState = "idle";
let activeToolCount = 0;
let cleanedUp = false;

let writeQueue: Promise<void> = Promise.resolve();
let writeSequence = 0;
function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function statusDir(): string {
  return expandHome(STATUS_DIR);
}

function statusFile(pid = PID): string {
  return join(statusDir(), `${pid}.json`);
}

function tmpStatusFile(pid = PID): string {
  writeSequence += 1;
  return join(statusDir(), `${pid}.json.${process.pid}.${writeSequence}.tmp`);
}

async function ensureStatusDir(): Promise<void> {
  await mkdir(statusDir(), { recursive: true });
}

function now(): number {
  return Date.now();
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function maybeCallString(object: unknown, methodName: string): string | undefined {
  const candidate = (object as Record<string, unknown> | undefined)?.[methodName];
  if (typeof candidate !== "function") return undefined;
  try {
    return asString(candidate.call(object));
  } catch {
    return undefined;
  }
}

function eventRecord(event: unknown): Record<string, unknown> {
  return (event && typeof event === "object" ? event : {}) as Record<string, unknown>;
}

function sessionNameFrom(event: unknown, ctx: ExtensionContext): string | undefined {
  const e = eventRecord(event);
  return (
    asString(e.sessionName) ??
    asString(e.name) ??
    asString(e.title) ??
    maybeCallString(ctx.sessionManager, "getSessionName") ??
    maybeCallString(ctx.sessionManager, "getName")
  );
}

function sessionIdFrom(event: unknown, ctx: ExtensionContext): string | undefined {
  const e = eventRecord(event);
  return (
    asString(e.sessionId) ??
    asString(e.id) ??
    maybeCallString(ctx.sessionManager, "getSessionId") ??
    maybeCallString(ctx.sessionManager, "getId")
  );
}

function sessionFileFrom(ctx: ExtensionContext): string | undefined {
  return maybeCallString(ctx.sessionManager, "getSessionFile");
}

async function readExisting(): Promise<Partial<PiZellijStatus> | undefined> {
  try {
    return JSON.parse(await readFile(statusFile(), "utf8")) as Partial<PiZellijStatus>;
  } catch {
    return undefined;
  }
}

function applyTitlePolicy(draft: PiZellijStatus, existing?: Partial<PiZellijStatus>): PiZellijStatus {
  const identityChanged = Boolean(
    existing?.sessionFile && draft.sessionFile && existing.sessionFile !== draft.sessionFile
  );

  if (!identityChanged && existing?.titleSource === "summary" && asString(existing.title)) {
    draft.title = existing.title as string;
    draft.titleSource = "summary";
    return draft;
  }

  if (draft.sessionName) {
    draft.title = draft.sessionName;
    draft.titleSource = "sessionName";
  } else if (!draft.title || draft.titleSource !== "summary") {
    draft.title = "new session";
    draft.titleSource = "none";
  }
  return draft;
}

async function writeStatus(partial: Partial<PiZellijStatus> = {}): Promise<void> {
  writeQueue = writeQueue
    .then(() => writeStatusNow(partial))
    .catch((error: unknown) => {
      // Status updates should never break an interactive pi turn.
      console.error("pi-zellij-bridge: failed to write status", error);
    });
  await writeQueue;
}

async function writeStatusNow(partial: Partial<PiZellijStatus> = {}): Promise<void> {
  if (!status || cleanedUp) return;
  const existing = await readExisting();
  if (!status || cleanedUp) return;
  const updated: PiZellijStatus = applyTitlePolicy(
    {
      ...status,
      ...partial,
      pid: PID,
      updatedAt: now(),
    },
    existing,
  );
  if (cleanedUp) return;
  status = updated;
  await ensureStatusDir();
  if (cleanedUp) return;
  const tmp = tmpStatusFile();
  const finalPath = statusFile();
  await writeFile(tmp, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  if (cleanedUp) {
    await rm(tmp, { force: true });
    return;
  }
  await rename(tmp, finalPath);
}

async function deleteStatus(): Promise<void> {
  cleanedUp = true;
  await writeQueue.catch(() => undefined);
  await rm(statusFile(), { force: true });
}

async function refreshSessionIdentity(event: unknown, ctx: ExtensionContext): Promise<void> {
  if (!status) return;
  const sessionName = sessionNameFrom(event, ctx);
  const sessionId = sessionIdFrom(event, ctx);
  const sessionFile = sessionFileFrom(ctx);
  const patch: Partial<PiZellijStatus> = {};
  if (sessionName !== undefined) patch.sessionName = sessionName;
  if (sessionId !== undefined) patch.sessionId = sessionId;
  if (sessionFile !== undefined) patch.sessionFile = sessionFile;
  await writeStatus(patch);
}

function isOutputMessage(event: unknown): boolean {
  const message = eventRecord(event).message;
  const msg = eventRecord(message);
  const role = asString(msg.role) ?? asString(eventRecord(event).role);
  return role === "assistant" || role === "tool" || role === "toolResult";
}

export default function zellijPiBridge(pi: ExtensionAPI) {
  pi.on("session_start", async (event, ctx) => {
    cleanedUp = false;
    const ts = now();
    const sessionName = sessionNameFrom(event, ctx);
    status = {
      pid: PID,
      title: sessionName ?? "new session",
      titleSource: sessionName ? "sessionName" : "none",
      sessionName,
      sessionId: sessionIdFrom(event, ctx),
      sessionFile: sessionFileFrom(ctx),
      cwd: ctx.cwd ?? process.cwd(),
      state: "starting",
      isStreaming: false,
      isCompacting: false,
      currentTool: undefined,
      turnCount: 0,
      startedAt: ts,
      lastOutputAt: ts,
      updatedAt: ts,
    };
    await writeStatus();
  });

  pi.on("agent_start", async (_event, _ctx) => {
    if (!status) return;
    activeToolCount = 0;
    await writeStatus({
      state: "running",
      isStreaming: true,
      currentTool: undefined,
      turnCount: status.turnCount + 1,
    });
  });

  pi.on("agent_end", async (_event, _ctx) => {
    if (!status) return;
    const ts = now();
    activeToolCount = 0;
    await writeStatus({
      state: "idle",
      isStreaming: false,
      isCompacting: false,
      currentTool: undefined,
      lastAgentEndAt: ts,
      lastOutputAt: ts,
    });
  });

  pi.on("message_update", async (event, _ctx) => {
    if (!status || !isOutputMessage(event)) return;
    await writeStatus({ state: status.isCompacting ? "compacting" : "running", isStreaming: true, lastOutputAt: now() });
  });

  pi.on("message_end", async (event, ctx) => {
    if (!status) return;
    const patch: Partial<PiZellijStatus> = {};
    if (isOutputMessage(event)) patch.lastOutputAt = now();
    const sessionName = sessionNameFrom(event, ctx);
    if (sessionName !== undefined && status.titleSource !== "summary") {
      patch.sessionName = sessionName;
      patch.title = sessionName;
      patch.titleSource = "sessionName";
    }
    await writeStatus(patch);
  });

  pi.on("tool_execution_start", async (event, _ctx) => {
    if (!status) return;
    activeToolCount += 1;
    await writeStatus({
      state: "running",
      isStreaming: true,
      currentTool: asString(eventRecord(event).toolName),
      lastOutputAt: now(),
    });
  });

  pi.on("tool_execution_update", async (event, _ctx) => {
    if (!status) return;
    await writeStatus({
      state: "running",
      isStreaming: true,
      currentTool: asString(eventRecord(event).toolName) ?? status.currentTool,
      lastOutputAt: now(),
    });
  });

  pi.on("tool_execution_end", async (event, _ctx) => {
    if (!status) return;
    activeToolCount = Math.max(0, activeToolCount - 1);
    await writeStatus({
      state: eventRecord(event).isError === true ? "error" : "running",
      isStreaming: true,
      currentTool: activeToolCount > 0 ? status.currentTool : undefined,
      lastOutputAt: now(),
    });
  });

  pi.on("tool_call", async (event, _ctx) => {
    if (!status) return;
    await writeStatus({ currentTool: asString(eventRecord(event).toolName), state: "running" });
  });

  pi.on("tool_result", async (event, _ctx) => {
    if (!status) return;
    await writeStatus({
      state: eventRecord(event).isError === true ? "error" : status.state,
      lastOutputAt: now(),
    });
  });

  pi.on("session_before_compact", async (_event, _ctx) => {
    if (!status) return;
    previousState = status.state === "compacting" ? previousState : status.state;
    await writeStatus({ state: "compacting", isCompacting: true });
  });

  pi.on("session_compact", async (_event, _ctx) => {
    if (!status) return;
    await writeStatus({ state: previousState === "compacting" ? "idle" : previousState, isCompacting: false });
  });

  async function markAsking(): Promise<void> {
    if (!status) return;
    previousState = status.state === "asking" ? previousState : status.state;
    await writeStatus({ state: "asking", isStreaming: false });
  }

  async function clearAsking(): Promise<void> {
    if (!status || status.state !== "asking") return;
    await writeStatus({ state: previousState === "asking" ? "idle" : previousState });
  }

  pi.on("prompt_start", markAsking);
  pi.on("question_start", markAsking);
  pi.on("interactive_prompt_start", markAsking);
  pi.on("user_prompt_start", markAsking);
  pi.on("prompt_end", clearAsking);
  pi.on("question_end", clearAsking);

  pi.on("input", async (_event, _ctx) => {
    await clearAsking();
  });

  pi.on("session_shutdown", async () => {
    await deleteStatus();
  });

  process.once("exit", () => {
    if (cleanedUp) return;
    try {
      rmSync(statusFile(), { force: true });
    } catch {
      // best effort only during process exit
    }
  });
}
