import { spawn, type ChildProcess } from "node:child_process";
import { open, readFile } from "node:fs/promises";

import type {
  JobProvider,
  JobStartInput,
  NormalizedJobError,
  ProviderJobHandle,
  ProviderStartContext,
  ProviderTerminalResult,
} from "@dotfiles/job-runtime";

const STOP_GRACE_MS = 5_000;

function normalizeError(error: unknown, code = "ERR_BASH_LAUNCH", phase = "bootstrap"): NormalizedJobError {
  if (error instanceof Error) {
    return {
      phase,
      name: error.name,
      code: (error as any).code === "ENOENT" ? "ERR_BASH_NOT_FOUND" : typeof (error as any).code === "string" ? (error as any).code : code,
      message: error.message,
      stack: error.stack,
    };
  }
  return { phase, name: "Error", code, message: String(error) };
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error: any) {
    if (error?.code !== "ESRCH") throw error;
  }
}

export class LocalBashJobProvider implements JobProvider {
  readonly type = "bash" as const;

  async start(
    input: Required<Pick<JobStartInput, "type" | "cmd" | "mode">> & Pick<JobStartInput, "timeout">,
    context: ProviderStartContext,
  ): Promise<ProviderJobHandle> {
    const outputFile = await open(context.record.outputPath, "w", 0o600);
    let writeQueue = Promise.resolve();
    let fileClosed = false;
    const append = (chunk: Buffer): void => {
      writeQueue = writeQueue.then(() => outputFile.write(chunk).then(() => undefined));
    };

    const child = spawn("bash", ["-c", input.cmd], {
      cwd: context.record.cwd,
      detached: true,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    try {
      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => {
          child.removeListener("error", onError);
          resolve();
        };
        const onError = (error: Error) => {
          child.removeListener("spawn", onSpawn);
          reject(error);
        };
        child.once("spawn", onSpawn);
        child.once("error", onError);
      });
    } catch (error) {
      await writeQueue;
      await outputFile.close();
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        code: (error as any)?.code === "ENOENT" ? "ERR_BASH_NOT_FOUND" : (error as any)?.code,
      });
    }

    let settled = false;
    let desiredStatus: "stopped" | "timed_out" | undefined;
    let stopReason: string | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let resolveCompletion!: (value: ProviderTerminalResult) => void;
    const completion = new Promise<ProviderTerminalResult>((resolve) => {
      resolveCompletion = resolve;
    });

    const closeOutput = async (): Promise<string> => {
      await writeQueue;
      if (!fileClosed) {
        fileClosed = true;
        await outputFile.close();
      }
      return readFile(context.record.outputPath, "utf8");
    };

    const finish = async (result: Omit<ProviderTerminalResult, "outputPath" | "outputText" | "outputPersisted">): Promise<void> => {
      if (settled) return;
      settled = true;
      if (forceTimer) clearTimeout(forceTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      let text = "";
      try {
        text = await closeOutput();
      } catch (error) {
        result = { status: "failed", error: normalizeError(error, "ERR_BASH_OUTPUT", "output") };
      }
      resolveCompletion({
        ...result,
        outputPath: context.record.outputPath,
        outputText: text,
        outputPersisted: true,
      });
    };

    child.once("error", (error) => {
      void finish({ status: "failed", error: normalizeError(error), exitCode: null, signal: null });
    });
    child.once("close", (exitCode, signal) => {
      if (desiredStatus) {
        void finish({ status: desiredStatus, exitCode, signal, stopReason });
      } else if (exitCode === 0) {
        void finish({ status: "completed", exitCode, signal });
      } else {
        void finish({ status: "failed", exitCode, signal });
      }
    });

    const stop = async (reason: string): Promise<void> => {
      if (settled || desiredStatus) return completion.then(() => undefined);
      stopReason = reason;
      desiredStatus = reason === "timeout" ? "timed_out" : "stopped";
      try {
        killGroup(child, "SIGTERM");
      } finally {
        forceTimer = setTimeout(() => {
          try {
            killGroup(child, "SIGKILL");
          } catch {
            // The close event owns finalization.
          }
        }, STOP_GRACE_MS);
        forceTimer.unref?.();
      }
      return completion.then(() => undefined);
    };

    if (input.timeout !== undefined) {
      timeoutTimer = setTimeout(() => void stop("timeout"), input.timeout * 1_000);
      timeoutTimer.unref?.();
    }
    return { completion, stop };
  }
}
