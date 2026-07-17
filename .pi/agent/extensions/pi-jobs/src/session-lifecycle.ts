import type { CompletionDelivery, CrashRecoveryOptions, JobManager } from "@dotfiles/job-runtime";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerSessionLifecycle(
  pi: ExtensionAPI,
  manager: JobManager,
  setBashToolActive: (active: boolean) => void,
  recoveryOptions: CrashRecoveryOptions = {},
): void {
  pi.on("session_start", async (_event, ctx) => {
    setBashToolActive(false);
    try {
      const recovery = await manager.recoverStaleArtifacts(recoveryOptions);
      if (recovery.errors.length > 0) {
        ctx.ui.notify(`Recovered ${recovery.recovered} crashed jobs with ${recovery.errors.length} cleanup error(s).`, "warning");
      }
    } catch (error) {
      ctx.ui.notify(`Job crash recovery failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
    const sessionId = ctx.sessionManager.getSessionId();
    manager.setDeliveryHandler(async (delivery: CompletionDelivery) => {
      const currentSessionId = ctx.sessionManager.getSessionId();
      if (delivery.job.sessionId !== currentSessionId) return;
      const idle = ctx.isIdle();
      pi.sendMessage(
        {
          customType: "job-completion",
          content: delivery.content,
          display: true,
          details: delivery.job,
        },
        idle ? { triggerTurn: true } : { deliverAs: "followUp" },
      );
    });
    // Ensure startup does not accidentally carry a handler for another session.
    if (sessionId !== ctx.sessionManager.getSessionId()) manager.setDeliveryHandler(undefined);
  });

  pi.on("session_shutdown", async (event, ctx) => {
    manager.setDeliveryHandler(undefined);
    if (event.reason !== "reload") {
      await manager.stopSession(ctx.sessionManager.getSessionId(), event.reason === "quit" ? "host_exited" : "session_replaced");
    }
  });
}
