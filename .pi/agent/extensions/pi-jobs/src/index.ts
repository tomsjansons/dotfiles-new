import {
  getGlobalJobManager,
  JavaScriptJobProvider,
  type CrashRecoveryOptions,
  type JobManager,
} from "@dotfiles/job-runtime";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createJobCommandControls } from "./commands.ts";
import { registerSessionLifecycle } from "./session-lifecycle.ts";
import { registerJobTools } from "./tools.ts";

const detectPlatform = (): NodeJS.Platform => process.platform;

interface PiJobsOptions {
  manager?: JobManager;
  recovery?: CrashRecoveryOptions;
}

/** The package's single Pi extension interface; implementation concerns stay internal. */
export default function piJobs(
  pi: ExtensionAPI,
  platform: () => NodeJS.Platform = detectPlatform,
  options: PiJobsOptions = {},
): void {
  const currentPlatform = platform();
  if (currentPlatform !== "linux") {
    let diagnosed = false;
    pi.on("session_start", (_event, ctx) => {
      if (diagnosed) return;
      diagnosed = true;
      ctx.ui.notify(
        `Managed job tools are unavailable on ${currentPlatform}: pi-jobs supports Linux only. The standalone bash tool remains active.`,
        "error",
      );
    });
    return;
  }

  const manager = options.manager ?? getGlobalJobManager();
  manager.providers.register(new JavaScriptJobProvider());

  const controls = createJobCommandControls(pi);
  registerJobTools(pi, manager, controls.showJobDetails);
  controls.registerCommands();
  registerSessionLifecycle(pi, manager, controls.setBashToolActive, options.recovery);
}
