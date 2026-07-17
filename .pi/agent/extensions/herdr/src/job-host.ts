import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { atomicJson } from "./atomic-json.mjs";
import { HerdrRequestError } from "./client.ts";
import { validateRunnerRequest, type RunnerRequest } from "./runner-protocol.mjs";
import type {
  HerdrClient,
  HerdrCommandHandle,
  HerdrCommandInput,
  HerdrCommandResult,
  HerdrJobHost,
  HerdrPane,
} from "./types.ts";

const RUNNER_PATH = fileURLToPath(new URL("./pane-runner.mjs", import.meta.url));
const ANCHOR_LABEL = "__pi_jobs_anchor__";
const JOB_LABEL_PREFIX = "__pi_job__";
const POLL_MS = 100;
const PANE_CHECK_MS = 500;
const STOP_GRACE_MS = 5_000;

export interface HerdrJobHostTiming {
  pollMs?: number;
  paneCheckMs?: number;
  stopGraceMs?: number;
}

interface ResolvedTiming {
  pollMs: number;
  paneCheckMs: number;
  stopGraceMs: number;
}

interface RunnerResult {
  exitCode: number | null;
  signal: string | null;
  error?: { code: string; message: string; stack?: string };
}

function errorWithCode(code: string, message: string): Error {
  const error = new Error(message);
  error.name = "HerdrJobError";
  (error as any).code = code;
  return error;
}

function attachCleanupFailure(primary: unknown, cleanupError: unknown, paneId: string): unknown {
  const context = `Failed to close newly allocated Herdr pane ${paneId} after pane marking failed`;
  if ((typeof primary === "object" && primary !== null) || typeof primary === "function") {
    try {
      Object.defineProperties(primary, {
        cleanupError: { configurable: true, enumerable: true, value: cleanupError },
        cleanupContext: { configurable: true, enumerable: true, value: context },
      });
      return primary;
    } catch {
      // Fall through for frozen/non-extensible thrown values while retaining them as the cause.
    }
  }
  const wrapped = errorWithCode(
    typeof (primary as any)?.code === "string" ? (primary as any).code : "ERR_HERDR_PANE_MARK",
    primary instanceof Error ? primary.message : String(primary),
  );
  wrapped.name = primary instanceof Error ? primary.name : wrapped.name;
  (wrapped as any).cause = primary;
  (wrapped as any).cleanupError = cleanupError;
  (wrapped as any).cleanupContext = context;
  return wrapped;
}

function resultError(error: unknown, fallbackCode: string, context?: string): NonNullable<HerdrCommandResult["error"]> {
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: typeof (error as any)?.code === "string" ? (error as any).code : fallbackCode,
    message: context ? `${context}: ${message}` : message,
    stack: error instanceof Error ? error.stack : undefined,
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function outputText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

function parseRunnerResult(text: string): RunnerResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw errorWithCode("ERR_HERDR_RUNNER_RESULT_INVALID", "Herdr runner result is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw errorWithCode("ERR_HERDR_RUNNER_RESULT_INVALID", "Herdr runner result must be an object");
  }
  const result = value as Record<string, unknown>;
  if (!(result.exitCode === null || (typeof result.exitCode === "number" && Number.isInteger(result.exitCode)))) {
    throw errorWithCode("ERR_HERDR_RUNNER_RESULT_INVALID", "Herdr runner result has an invalid exitCode");
  }
  if (!(result.signal === null || typeof result.signal === "string")) {
    throw errorWithCode("ERR_HERDR_RUNNER_RESULT_INVALID", "Herdr runner result has an invalid signal");
  }
  if (result.error !== undefined) {
    if (typeof result.error !== "object" || result.error === null || Array.isArray(result.error)) {
      throw errorWithCode("ERR_HERDR_RUNNER_RESULT_INVALID", "Herdr runner result has an invalid error");
    }
    const diagnostic = result.error as Record<string, unknown>;
    if (typeof diagnostic.code !== "string" || typeof diagnostic.message !== "string"
      || (diagnostic.stack !== undefined && typeof diagnostic.stack !== "string")) {
      throw errorWithCode("ERR_HERDR_RUNNER_RESULT_INVALID", "Herdr runner result has an invalid error");
    }
  }
  return value as RunnerResult;
}

export class DefaultHerdrJobHost implements HerdrJobHost {
  readonly client: HerdrClient;
  readonly workspaceId: string;
  readonly tabLabel: string;
  #allocation: Promise<void> = Promise.resolve();
  #anchorHint?: string;
  readonly #timing: ResolvedTiming;

  constructor(client: HerdrClient, workspaceId: string, tabLabel = "pi-shell", timing: HerdrJobHostTiming = {}) {
    this.client = client;
    this.workspaceId = workspaceId;
    this.tabLabel = tabLabel;
    this.#timing = {
      pollMs: timing.pollMs ?? POLL_MS,
      paneCheckMs: timing.paneCheckMs ?? PANE_CHECK_MS,
      stopGraceMs: timing.stopGraceMs ?? STOP_GRACE_MS,
    };
  }

  async start(input: HerdrCommandInput): Promise<HerdrCommandHandle> {
    const requestPath = join(input.artifactDir, "request.json");
    const resultPath = join(input.artifactDir, "runner-result.json");
    const request: RunnerRequest = validateRunnerRequest({
      id: input.id,
      cmd: input.cmd,
      cwd: input.cwd,
      outputPath: input.outputPath,
      resultPath,
      env: Object.fromEntries(Object.entries(input.env ?? process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    });
    await writeFile(input.outputPath, Buffer.alloc(0), { mode: 0o600 });
    await atomicJson(requestPath, request);

    const pane = await this.#allocatePane(input.cwd, input.id);
    const paneLabel = `${JOB_LABEL_PREFIX}${input.id}`;
    const launcher = `exec ${shellQuote(process.execPath)} ${shellQuote(RUNNER_PATH)} ${shellQuote(requestPath)}`;
    try {
      await input.onOwnedPane?.({ ...pane, label: paneLabel }, paneLabel);
      await this.client.sendInput(pane.pane_id, launcher);
    } catch (launchError) {
      let error = resultError(launchError, "ERR_HERDR_JOB_LAUNCH", `Failed to launch command in Herdr job pane ${pane.pane_id}`);
      try {
        await this.client.closePane(pane.pane_id);
      } catch (closeError) {
        const launchMessage = error.message;
        error = resultError(
          closeError,
          "ERR_HERDR_PANE_CLOSE",
          `Failed to close Herdr job pane ${pane.pane_id} after launch failed (${launchMessage})`,
        );
      }
      const completion = Promise.resolve<HerdrCommandResult>({
        status: "failed",
        outputText: await outputText(input.outputPath).catch(() => ""),
        error,
      });
      return {
        completion,
        async stop() { await completion; },
      };
    }

    let settled = false;
    let desiredStatus: "stopped" | "timed_out" | undefined;
    let stopReason: string | undefined;
    let pollTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    let lastPaneCheck = 0;
    let missingChecks = 0;
    let stopClosePending = false;
    let resolveCompletion!: (value: HerdrCommandResult) => void;
    const completion = new Promise<HerdrCommandResult>((resolve) => {
      resolveCompletion = resolve;
    });

    const finish = async (result: HerdrCommandResult, cleanupPane = false): Promise<void> => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
      if (cleanupPane) {
        try {
          await this.client.closePane(pane.pane_id);
        } catch (error) {
          result = {
            status: "failed",
            outputText: result.outputText,
            exitCode: result.exitCode,
            signal: result.signal,
            stopReason: result.stopReason,
            error: resultError(error, "ERR_HERDR_PANE_CLOSE", `Failed to clean up Herdr job pane ${pane.pane_id}`),
          };
        }
      }
      resolveCompletion(result);
    };

    const finishStopped = async (): Promise<void> => {
      if (!desiredStatus) throw errorWithCode("ERR_HERDR_STOP_STATE", "Cannot finalize a Herdr stop before one is requested");
      await finish({
        status: desiredStatus,
        outputText: await outputText(input.outputPath),
        stopReason,
      });
    };

    const finishFailure = async (error: unknown, fallbackCode: string, context?: string): Promise<void> => {
      await finish({
        status: "failed",
        outputText: await outputText(input.outputPath).catch(() => ""),
        stopReason,
        error: resultError(error, fallbackCode, context),
      });
    };

    const inspectResult = async (): Promise<boolean> => {
      try {
        await access(resultPath);
      } catch (error: any) {
        if (error?.code === "ENOENT") return false;
        throw error;
      }
      const result = parseRunnerResult(await readFile(resultPath, "utf8"));
      // A stop request owns settlement while closePane is in flight. Otherwise
      // a concurrently observed sidecar could hide a close transport failure.
      if (stopClosePending) return false;
      if (desiredStatus) {
        await finish({
          status: desiredStatus,
          outputText: await outputText(input.outputPath),
          exitCode: result.exitCode,
          signal: result.signal,
          stopReason,
        });
      } else if (result.error) {
        await finish({
          status: "failed",
          outputText: await outputText(input.outputPath),
          exitCode: result.exitCode,
          signal: result.signal,
          error: result.error,
        }, true);
      } else {
        await finish({
          status: result.exitCode === 0 ? "completed" : "failed",
          outputText: await outputText(input.outputPath),
          exitCode: result.exitCode,
          signal: result.signal,
        }, true);
      }
      return true;
    };

    const poll = async (): Promise<void> => {
      if (settled) return;
      try {
        if (await inspectResult()) return;
        if (stopClosePending) {
          pollTimer = setTimeout(() => void poll(), this.#timing.pollMs);
          pollTimer.unref?.();
          return;
        }
        if (Date.now() - lastPaneCheck >= this.#timing.paneCheckMs) {
          lastPaneCheck = Date.now();
          const panes = await this.client.listPanes(this.workspaceId);
          if (panes.some((candidate) => candidate.pane_id === pane.pane_id)) missingChecks = 0;
          else missingChecks += 1;
          if (missingChecks >= 2 && !stopClosePending) {
            if (desiredStatus) await finishStopped();
            else {
              await finish({
                status: "failed",
                outputText: await outputText(input.outputPath),
                error: {
                  code: "ERR_HERDR_RUNNER_EXIT",
                  message: "Herdr job pane exited without writing a runner result",
                },
              });
            }
            return;
          }
        }
      } catch (error) {
        await finishFailure(error, desiredStatus ? "ERR_HERDR_STOP_VERIFY" : "ERR_HERDR_JOB_WATCH");
        return;
      }
      pollTimer = setTimeout(() => void poll(), this.#timing.pollMs);
      pollTimer.unref?.();
    };

    const stop = async (reason: string): Promise<void> => {
      if (settled || desiredStatus) return completion.then(() => undefined);
      stopReason = reason;
      desiredStatus = reason === "timeout" ? "timed_out" : "stopped";
      stopClosePending = true;
      try {
        await this.client.closePane(pane.pane_id);
      } catch (error) {
        stopClosePending = false;
        await finishFailure(error, "ERR_HERDR_STOP_CLOSE", `Failed to close Herdr job pane ${pane.pane_id}`);
        return completion.then(() => undefined);
      }
      stopClosePending = false;

      try {
        if (await inspectResult()) return completion.then(() => undefined);
        const panes = await this.client.listPanes(this.workspaceId);
        if (!panes.some((candidate) => candidate.pane_id === pane.pane_id)) {
          await finishStopped();
          return completion.then(() => undefined);
        }
      } catch (error) {
        await finishFailure(error, "ERR_HERDR_STOP_VERIFY", `Failed to verify Herdr job pane ${pane.pane_id} termination`);
        return completion.then(() => undefined);
      }

      graceTimer = setTimeout(() => {
        void (async () => {
          try {
            if (await inspectResult()) return;
            const panes = await this.client.listPanes(this.workspaceId);
            if (!panes.some((candidate) => candidate.pane_id === pane.pane_id)) await finishStopped();
            else {
              await finishFailure(
                errorWithCode("ERR_HERDR_STOP_UNVERIFIED", `Herdr job pane ${pane.pane_id} remained alive after the stop grace period`),
                "ERR_HERDR_STOP_UNVERIFIED",
              );
            }
          } catch (error) {
            await finishFailure(error, "ERR_HERDR_STOP_VERIFY", `Failed to verify Herdr job pane ${pane.pane_id} termination`);
          }
        })();
      }, this.#timing.stopGraceMs);
      graceTimer.unref?.();
      return completion.then(() => undefined);
    };

    if (input.timeout !== undefined) {
      timeoutTimer = setTimeout(() => void stop("timeout"), input.timeout * 1_000);
      timeoutTimer.unref?.();
    }
    void poll();
    return { completion, stop };
  }

  async #allocatePane(cwd: string, jobId: string): Promise<HerdrPane> {
    let release!: () => void;
    const previous = this.#allocation;
    this.#allocation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const anchor = await this.#resolveAnchor(cwd);
        let pane: HerdrPane;
        try {
          pane = await this.client.splitPane({
            workspaceId: this.workspaceId,
            targetPaneId: anchor.pane_id,
            direction: "right",
            ratio: 0.5,
            cwd,
            focus: false,
          });
        } catch (error) {
          if (attempt === 0 && error instanceof HerdrRequestError && error.serverCode === "pane_not_found") {
            this.#anchorHint = undefined;
            continue;
          }
          throw error;
        }
        if (pane.pane_id === anchor.pane_id) {
          throw errorWithCode("ERR_HERDR_PANE_OWNERSHIP", "Herdr pane.split returned the anchor pane instead of a newly owned pane");
        }
        try {
          await this.client.renamePane(pane.pane_id, `${JOB_LABEL_PREFIX}${jobId}`);
        } catch (error) {
          try {
            await this.client.closePane(pane.pane_id);
          } catch (cleanupError) {
            throw attachCleanupFailure(error, cleanupError, pane.pane_id);
          }
          throw error;
        }
        return pane;
      }
      throw errorWithCode("ERR_HERDR_ANCHOR", "Unable to allocate a Herdr job pane");
    } finally {
      release();
    }
  }

  async #resolveAnchor(cwd: string): Promise<HerdrPane> {
    const tabs = (await this.client.listTabs(this.workspaceId)).filter((tab) => tab.label === this.tabLabel);
    if (tabs.length > 1) {
      throw errorWithCode(
        "ERR_HERDR_DUPLICATE_TAB",
        `Multiple Herdr tabs are labelled ${JSON.stringify(this.tabLabel)}: ${tabs.map((tab) => tab.tab_id).join(", ")}`,
      );
    }
    if (tabs.length === 0) {
      const created = await this.client.createTab({ workspaceId: this.workspaceId, cwd, label: this.tabLabel, focus: false });
      await this.client.renamePane(created.rootPane.pane_id, ANCHOR_LABEL);
      this.#anchorHint = created.rootPane.pane_id;
      return { ...created.rootPane, label: ANCHOR_LABEL };
    }

    const panes = (await this.client.listPanes(this.workspaceId)).filter((pane) => pane.tab_id === tabs[0]!.tab_id);
    if (this.#anchorHint) {
      const hinted = panes.find((pane) => pane.pane_id === this.#anchorHint && pane.label === ANCHOR_LABEL);
      if (hinted) return hinted;
    }
    const anchors = panes.filter((pane) => pane.label === ANCHOR_LABEL);
    if (anchors.length > 1) {
      throw errorWithCode("ERR_HERDR_DUPLICATE_ANCHOR", `Tab ${tabs[0]!.tab_id} has multiple pi-jobs anchor panes`);
    }
    if (anchors.length === 1) {
      this.#anchorHint = anchors[0]!.pane_id;
      return anchors[0]!;
    }
    const candidate = panes.find((pane) => !pane.label?.startsWith(JOB_LABEL_PREFIX));
    if (!candidate) throw errorWithCode("ERR_HERDR_ANCHOR", `Tab ${tabs[0]!.tab_id} has no pane available as an anchor`);
    await this.client.renamePane(candidate.pane_id, ANCHOR_LABEL);
    this.#anchorHint = candidate.pane_id;
    return { ...candidate, label: ANCHOR_LABEL };
  }
}
