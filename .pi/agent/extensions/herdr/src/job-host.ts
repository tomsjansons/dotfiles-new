import { access, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { HerdrRequestError } from "./client.ts";
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

function errorWithCode(code: string, message: string): Error {
  const error = new Error(message);
  error.name = "HerdrJobError";
  (error as any).code = code;
  return error;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

async function outputText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

export class DefaultHerdrJobHost implements HerdrJobHost {
  readonly client: HerdrClient;
  readonly workspaceId: string;
  readonly tabLabel: string;
  #allocation: Promise<void> = Promise.resolve();
  #anchorHint?: string;

  constructor(client: HerdrClient, workspaceId: string, tabLabel = "pi-shell") {
    this.client = client;
    this.workspaceId = workspaceId;
    this.tabLabel = tabLabel;
  }

  async start(input: HerdrCommandInput): Promise<HerdrCommandHandle> {
    const requestPath = join(input.artifactDir, "request.json");
    const resultPath = join(input.artifactDir, "runner-result.json");
    await writeFile(input.outputPath, Buffer.alloc(0), { mode: 0o600 });
    await atomicJson(requestPath, {
      id: input.id,
      cmd: input.cmd,
      cwd: input.cwd,
      outputPath: input.outputPath,
      resultPath,
      env: Object.fromEntries(Object.entries(input.env ?? process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    });

    const pane = await this.#allocatePane(input.cwd, input.id);
    const launcher = `exec ${shellQuote(process.execPath)} ${shellQuote(RUNNER_PATH)} ${shellQuote(requestPath)}`;
    try {
      await this.client.sendInput(pane.pane_id, launcher);
    } catch (error) {
      await this.client.closePane(pane.pane_id).catch(() => undefined);
      throw error;
    }

    let settled = false;
    let desiredStatus: "stopped" | "timed_out" | undefined;
    let stopReason: string | undefined;
    let pollTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;
    let lastPaneCheck = 0;
    let missingChecks = 0;
    let resolveCompletion!: (value: HerdrCommandResult) => void;
    const completion = new Promise<HerdrCommandResult>((resolve) => {
      resolveCompletion = resolve;
    });

    const finish = async (result: HerdrCommandResult): Promise<void> => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearTimeout(pollTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
      await this.client.closePane(pane.pane_id).catch(() => undefined);
      resolveCompletion(result);
    };

    const finishStopped = async (): Promise<void> => {
      await finish({
        status: desiredStatus ?? "stopped",
        outputText: await outputText(input.outputPath),
        stopReason,
      });
    };

    const inspectResult = async (): Promise<boolean> => {
      try {
        await access(resultPath);
      } catch (error: any) {
        if (error?.code === "ENOENT") return false;
        throw error;
      }
      const result = JSON.parse(await readFile(resultPath, "utf8"));
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
        });
      } else {
        await finish({
          status: result.exitCode === 0 ? "completed" : "failed",
          outputText: await outputText(input.outputPath),
          exitCode: result.exitCode,
          signal: result.signal,
        });
      }
      return true;
    };

    const poll = async (): Promise<void> => {
      if (settled) return;
      try {
        if (await inspectResult()) return;
        if (Date.now() - lastPaneCheck >= PANE_CHECK_MS) {
          lastPaneCheck = Date.now();
          const panes = await this.client.listPanes(this.workspaceId);
          if (panes.some((candidate) => candidate.pane_id === pane.pane_id)) missingChecks = 0;
          else missingChecks += 1;
          if (missingChecks >= 2) {
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
      } catch (error: any) {
        await finish({
          status: desiredStatus ?? "failed",
          outputText: await outputText(input.outputPath).catch(() => ""),
          stopReason,
          error: desiredStatus ? undefined : {
            code: typeof error?.code === "string" ? error.code : "ERR_HERDR_JOB_WATCH",
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          },
        });
        return;
      }
      pollTimer = setTimeout(() => void poll(), POLL_MS);
      pollTimer.unref?.();
    };

    const stop = async (reason: string): Promise<void> => {
      if (settled || desiredStatus) return completion.then(() => undefined);
      stopReason = reason;
      desiredStatus = reason === "timeout" ? "timed_out" : "stopped";
      await this.client.closePane(pane.pane_id).catch(() => undefined);
      graceTimer = setTimeout(() => void finishStopped(), STOP_GRACE_MS);
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
        try {
          const pane = await this.client.splitPane({
            workspaceId: this.workspaceId,
            targetPaneId: anchor.pane_id,
            direction: "right",
            ratio: 0.5,
            cwd,
            focus: false,
          });
          await this.client.renamePane(pane.pane_id, `${JOB_LABEL_PREFIX}${jobId}`);
          return pane;
        } catch (error) {
          if (attempt === 0 && error instanceof HerdrRequestError && error.serverCode === "pane_not_found") {
            this.#anchorHint = undefined;
            continue;
          }
          throw error;
        }
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
