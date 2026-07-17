import { getGlobalJobManager } from "@dotfiles/job-runtime";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { RoutedBashJobProvider } from "./routed-provider.ts";

const detectPlatform = (): NodeJS.Platform => process.platform;

export default function bashJobs(pi: ExtensionAPI, platform: () => NodeJS.Platform = detectPlatform): void {
  if (platform() !== "linux") return;
  const provider = new RoutedBashJobProvider();
  getGlobalJobManager().providers.register(provider);

  pi.on("session_start", (_event, ctx) => {
    provider.setWarningHandler((message) => ctx.ui.notify(message, "warning"));
  });
  pi.on("session_shutdown", () => {
    provider.setWarningHandler(undefined);
  });
}
