import {
  DefaultHerdrJobHost,
  discoverHerdr,
  hasHerdrMarkers,
  UnixHerdrClient,
  type HerdrJobHost,
} from "@dotfiles/herdr";
import type {
  JobProvider,
  JobStartInput,
  NormalizedJobError,
  PersistedJob,
  ProviderJobHandle,
  ProviderRecovery,
  ProviderStartContext,
} from "@dotfiles/job-runtime";

import { LocalBashJobProvider } from "./local-provider.ts";

function normalizeError(error: unknown, phase = "execution", code = "ERR_HERDR_JOB"): NormalizedJobError {
  if (error instanceof Error) {
    return {
      phase,
      name: error.name,
      code: typeof (error as any).code === "string" ? (error as any).code : code,
      message: error.message,
      stack: error.stack,
    };
  }
  return { phase, name: "Error", code, message: String(error) };
}

export class RoutedBashJobProvider implements JobProvider {
  readonly type = "bash" as const;
  readonly #local = new LocalBashJobProvider();
  readonly #hosts = new Map<string, HerdrJobHost>();
  #warningHandler?: (message: string) => void;
  #warnedDiscovery = false;

  setWarningHandler(handler: ((message: string) => void) | undefined): void {
    this.#warningHandler = handler;
  }

  async start(
    input: Required<Pick<JobStartInput, "type" | "cmd" | "mode">> & Pick<JobStartInput, "timeout">,
    context: ProviderStartContext,
  ): Promise<ProviderJobHandle> {
    if (process.platform !== "linux") {
      const error = new Error(`Bash jobs support Linux only; current platform is ${process.platform}`);
      (error as any).code = "ERR_JOB_PLATFORM_UNSUPPORTED";
      throw error;
    }

    let discovered;
    try {
      discovered = await discoverHerdr(process.env);
    } catch (error) {
      if (hasHerdrMarkers(process.env) && !this.#warnedDiscovery) {
        this.#warnedDiscovery = true;
        this.#warningHandler?.(`Herdr validation failed; bash jobs will run locally. ${error instanceof Error ? error.message : String(error)}`);
      }
      return this.#local.start(input, context);
    }
    if (!discovered) return this.#local.start(input, context);

    const key = `${discovered.socketPath}\0${discovered.workspaceId}`;
    let host = this.#hosts.get(key);
    if (!host) {
      host = new DefaultHerdrJobHost(new UnixHerdrClient(discovered.socketPath), discovered.workspaceId, "pi-shell");
      this.#hosts.set(key, host);
    }
    const handle = await host.start({
      id: context.record.id,
      cmd: input.cmd,
      cwd: context.record.cwd,
      artifactDir: context.record.artifactDir,
      outputPath: context.record.outputPath,
      timeout: input.timeout,
      env: process.env,
      onOwnedPane: async (pane, paneLabel) => {
        await context.setResource({
          kind: "herdr_pane",
          socketPath: discovered.socketPath,
          workspaceId: discovered.workspaceId,
          paneId: pane.pane_id,
          paneLabel,
        });
      },
    });
    return {
      stop: (reason) => handle.stop(reason),
      completion: handle.completion.then((result) => ({
        status: result.status,
        outputPath: context.record.outputPath,
        outputText: result.outputText,
        outputPersisted: true,
        exitCode: result.exitCode,
        signal: result.signal,
        stopReason: result.stopReason,
        error: result.error ? normalizeError(Object.assign(new Error(result.error.message), result.error)) : undefined,
      })),
    };
  }

  async recover(job: PersistedJob): Promise<ProviderRecovery> {
    const resource = job.providerResource;
    if (resource?.kind === "local_process") return this.#local.recover(job);
    if (resource?.kind !== "herdr_pane") return { reclaimed: false };
    const expectedLabel = `__pi_job__${job.id}`;
    if (resource.paneLabel !== expectedLabel) return { reclaimed: false, detail: "ownership label mismatch" };

    const client = new UnixHerdrClient(resource.socketPath);
    const pane = (await client.listPanes(resource.workspaceId)).find(
      (candidate) => candidate.pane_id === resource.paneId && candidate.label === expectedLabel,
    );
    if (!pane) return { reclaimed: false };
    await client.closePane(pane.pane_id);
    return { reclaimed: true };
  }
}
