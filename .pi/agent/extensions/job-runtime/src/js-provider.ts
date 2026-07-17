import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { captureOwnedProcess, reclaimOwnedProcessGroup } from "./process-ownership.ts";
import type {
  JobProvider,
  JobStartInput,
  NormalizedJobError,
  PersistedJob,
  ProviderJobHandle,
  ProviderRecovery,
  ProviderStartContext,
  ProviderTerminalResult,
} from "./types.ts";

const CHILD_PATH = fileURLToPath(new URL("./runtime-child.mjs", import.meta.url));
const STOP_GRACE_MS = 5_000;
const READY_TIMEOUT_MS = 5_000;

function normalizeError(error: unknown, code = "ERR_JOB_PROVIDER"): NormalizedJobError {
  if (error instanceof Error) {
    return {
      phase: "bootstrap",
      name: error.name,
      code: typeof (error as any).code === "string" ? (error as any).code : code,
      message: error.message,
      stack: error.stack,
      cause: (error as any).cause,
    };
  }
  return { phase: "bootstrap", name: "Error", code, message: String(error) };
}

function failureYaml(error: NormalizedJobError): string {
  return `json:\n  error:\n    phase: ${JSON.stringify(error.phase)}\n    name: ${JSON.stringify(error.name)}\n    code: ${JSON.stringify(error.code)}\n    message: ${JSON.stringify(error.message)}\n`;
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error: any) {
    if (error?.code !== "ESRCH") throw error;
  }
}

export class JavaScriptJobProvider implements JobProvider {
  readonly type = "js" as const;

  async start(
    input: Required<Pick<JobStartInput, "type" | "cmd" | "mode">> & Pick<JobStartInput, "timeout">,
    context: ProviderStartContext,
  ): Promise<ProviderJobHandle> {
    const child = spawn(
      process.execPath,
      [
        "--no-warnings",
        "--experimental-vm-modules",
        "--permission",
        "--allow-fs-read=*",
        "--allow-fs-write=*",
        "--allow-net",
        CHILD_PATH,
      ],
      {
        cwd: context.record.cwd,
        detached: true,
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        serialization: "advanced",
      },
    );

    let settled = false;
    let ready = false;
    let resourcePersisted = false;
    let runSent = false;
    let stopStatus: "stopped" | "timed_out" | undefined;
    let stopReason: string | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let readyTimer: NodeJS.Timeout | undefined;
    let resolveCompletion!: (value: ProviderTerminalResult) => void;

    const completion = new Promise<ProviderTerminalResult>((resolve) => {
      resolveCompletion = resolve;
    });

    const finish = (result: ProviderTerminalResult): void => {
      if (settled) return;
      settled = true;
      if (forceTimer) clearTimeout(forceTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (readyTimer) clearTimeout(readyTimer);
      resolveCompletion(result);
    };

    const stop = async (reason: string): Promise<void> => {
      if (settled || stopStatus) return;
      stopReason = reason;
      stopStatus = reason === "timeout" ? "timed_out" : "stopped";
      try {
        killGroup(child, "SIGTERM");
      } finally {
        forceTimer = setTimeout(() => {
          try {
            killGroup(child, "SIGKILL");
          } catch {
            // Exit handling owns the final result.
          }
        }, STOP_GRACE_MS);
        forceTimer.unref?.();
      }
    };

    const sendRun = (): void => {
      if (runSent || settled || stopStatus || !ready || !resourcePersisted || !child.connected) return;
      runSent = true;
      child.send({
        kind: "run",
        jobId: context.record.id,
        cmd: input.cmd,
        cwd: context.record.cwd,
        sourcePath: `${context.record.artifactDir}/source.js`,
      });
    };

    child.on("message", (message: any) => {
      if (message?.kind === "ready") {
        ready = true;
        if (readyTimer) clearTimeout(readyTimer);
        sendRun();
        return;
      }
      if (message?.kind === "rpc_request") {
        void context.invoke(message.method, message.args).then(
          (value) => child.connected && child.send({ kind: "rpc_response", id: message.id, ok: true, value }),
          (error) => {
            const normalized = normalizeError(error, "ERR_JOB_RPC");
            if (child.connected) child.send({ kind: "rpc_response", id: message.id, ok: false, error: normalized });
          },
        );
        return;
      }
      if (message?.kind === "terminal") {
        finish({
          status: message.status,
          outputPath: context.record.outputPath,
          outputText: message.outputYaml,
          error: message.error,
        });
      }
    });

    child.once("error", (error) => {
      const normalized = normalizeError(error, "ERR_JOB_CHILD_SPAWN");
      finish({ status: "failed", outputPath: context.record.outputPath, outputText: failureYaml(normalized), error: normalized });
    });

    child.once("exit", (code, signal) => {
      if (settled) return;
      if (stopStatus) {
        finish({
          status: stopStatus,
          outputPath: context.record.outputPath,
          exitCode: code,
          signal,
          stopReason,
          outputText: `json:\n  status: ${stopStatus}\n  reason: ${JSON.stringify(stopReason)}\n`,
        });
        return;
      }
      const error: NormalizedJobError = {
        phase: ready ? "execution" : "bootstrap",
        name: "JobChildExitError",
        code: "ERR_JOB_CHILD_EXIT",
        message: `JavaScript child exited before reporting a result (code=${String(code)}, signal=${String(signal)})`,
        exitCode: code,
        signal,
      };
      finish({ status: "failed", outputPath: context.record.outputPath, exitCode: code, signal, error, outputText: failureYaml(error) });
    });

    readyTimer = setTimeout(() => {
      if (ready || settled) return;
      const error: NormalizedJobError = {
        phase: "bootstrap",
        name: "JobChildReadyTimeoutError",
        code: "ERR_JOB_CHILD_READY_TIMEOUT",
        message: `JavaScript child did not become ready within ${READY_TIMEOUT_MS}ms`,
      };
      void stop("bootstrap_timeout");
      finish({ status: "failed", outputPath: context.record.outputPath, error, outputText: failureYaml(error) });
    }, READY_TIMEOUT_MS);
    readyTimer.unref?.();

    if (input.timeout !== undefined && input.timeout > 0) {
      timeoutTimer = setTimeout(() => void stop("timeout"), input.timeout * 1_000);
      timeoutTimer.unref?.();
    }

    try {
      await context.setResource(await captureOwnedProcess(child.pid!, "js"));
      resourcePersisted = true;
      sendRun();
    } catch (error) {
      await stop("ownership_error");
      throw error;
    }
    return { completion, stop };
  }

  async recover(job: PersistedJob): Promise<ProviderRecovery> {
    const resource = job.providerResource;
    if (resource?.kind !== "local_process" || resource.owner !== "js") return { reclaimed: false };
    return { reclaimed: await reclaimOwnedProcessGroup(resource) };
  }
}
