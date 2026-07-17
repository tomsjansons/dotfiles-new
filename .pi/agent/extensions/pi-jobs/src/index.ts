import { basename } from "node:path";

import {
  getGlobalJobManager,
  JavaScriptJobProvider,
  type CompletionDelivery,
  type JobInvocationContext,
  type JobListInput,
  type JobListResult,
  type JobSnapshot,
  type JobStartInput,
} from "@dotfiles/job-runtime";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";

const jobSchema = Type.Object({
  type: Type.Union([Type.Literal("js"), Type.Literal("bash")], { description: "Job provider type" }),
  cmd: Type.String({ description: "JavaScript function body or bash command" }),
  mode: Type.Optional(Type.Union([Type.Literal("sync"), Type.Literal("async")], { description: "Default: sync" })),
  timeout: Type.Optional(Type.Number({ description: "Optional timeout in seconds; no default" })),
});

const jobListSchema = Type.Object({
  type: Type.Optional(Type.Union([Type.Literal("js"), Type.Literal("bash")])),
  include: Type.Optional(Type.Union([Type.Literal("running"), Type.Literal("non-running"), Type.Literal("all")])),
  cursor: Type.Optional(Type.String({ description: "Opaque cursor returned by an earlier job_list call" })),
});

const jobStopSchema = Type.Object({
  id: Type.String({ description: "Job ID" }),
});

type JobToolDetails = { operation: "job" | "job_list" | "job_stop"; job?: JobSnapshot; list?: JobListResult };

function sessionContext(ctx: ExtensionContext, rootToolCallId?: string): JobInvocationContext {
  const sessionId = ctx.sessionManager.getSessionId();
  const sessionPath = ctx.sessionManager.getSessionFile();
  const fileTimestamp = sessionPath ? basename(sessionPath).split("_")[0] : undefined;
  return {
    cwd: ctx.cwd,
    sessionId,
    sessionPath,
    sessionTimestamp: fileTimestamp,
    rootToolCallId,
  };
}

function jobText(job: JobSnapshot): string {
  const duration = job.durationMs === undefined ? "" : ` in ${(job.durationMs / 1_000).toFixed(1)}s`;
  const lines = [`${job.type} job ${job.id}: ${job.status}${duration}`];
  if (job.output) lines.push("", job.output);
  lines.push("", `Full output: ${job.outputPath}`);
  return lines.join("\n");
}

function runningText(job: JobSnapshot): string {
  return `${job.type} job ${job.id}: ${job.status} (${((Date.now() - Date.parse(job.startedAt)) / 1_000).toFixed(1)}s)`;
}

function compactDetails(details: JobToolDetails | undefined): string {
  if (details?.job) {
    const job = details.job;
    const duration = job.durationMs === undefined ? "" : ` ${(job.durationMs / 1_000).toFixed(1)}s`;
    return `${job.type}/${job.mode} ${job.id} ${job.status}${duration}`;
  }
  if (details?.list) return `${details.list.running.length} running, ${details.list.nonRunningCount} non-running`;
  return details?.operation ?? "job";
}

export default function piJobs(pi: ExtensionAPI): void {
  const manager = getGlobalJobManager();
  manager.providers.register(new JavaScriptJobProvider());

  pi.registerTool({
    name: "job",
    label: "Job",
    description:
      "Run a managed JavaScript or bash job. JavaScript cmd is an async function body: use top-level await and return output explicitly; console is unavailable. Both outer and nested JavaScript contexts expose job/job_list/job_stop. JavaScript has unrestricted dynamic imports, filesystem, and network (including fetch), but cannot spawn subprocesses directly. Bash uses explicit bash -c. Sync returns bounded head/tail output plus outputPath; async returns immediately and only root async jobs notify on completion. Use read outside JavaScript or node:fs/promises inside JavaScript for full output. There are no job read/wait operations; compose Promise timers and job_list instead.",
    promptSnippet: "Run managed JavaScript or bash jobs (sync or async)",
    promptGuidelines: [
      "Use job({type:'bash', cmd, mode}) for all model shell commands; the standalone bash tool is unavailable after the bash provider is installed.",
      "Read complete job output from outputPath: use the normal read tool outside JavaScript or node:fs/promises inside it.",
      "Nested jobs never notify automatically; explicitly return child metadata/output paths when they should be surfaced.",
    ],
    parameters: jobSchema,
    executionMode: "parallel",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      let interval: NodeJS.Timeout | undefined;
      let startedJobId: string | undefined;
      try {
        const result = await manager.start(
          params as JobStartInput,
          sessionContext(ctx, toolCallId),
          signal,
          (started) => {
            startedJobId = started.id;
            onUpdate?.({
              content: [{ type: "text", text: runningText(started) }],
              details: { operation: "job", job: started },
            });
            if ((params.mode ?? "sync") === "sync") {
              interval = setInterval(() => {
                const current = manager.get(started.id);
                if (!current) return;
                onUpdate?.({
                  content: [{ type: "text", text: runningText(current) }],
                  details: { operation: "job", job: current },
                });
              }, 1_000);
              interval.unref?.();
            }
          },
        );
        return {
          content: [{ type: "text", text: params.mode === "async" ? `Started ${jobText(result)}` : jobText(result) }],
          details: { operation: "job", job: result },
        };
      } finally {
        if (interval) clearInterval(interval);
        if (startedJobId && signal?.aborted) {
          // Manager owns cancellation; retaining the ID here makes the lifecycle explicit.
        }
      }
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", `job ${args.type}/${args.mode ?? "sync"}`), 0, 0);
    },
    renderResult(result, _options, theme) {
      return new Text(theme.fg("muted", compactDetails(result.details as JobToolDetails | undefined)), 0, 0);
    },
  });

  pi.registerTool({
    name: "job_list",
    label: "Job list",
    description:
      "List managed jobs. With no arguments, returns every running job plus the current session non-running count. include='non-running' returns the newest 50 terminal jobs and nextCursor; include='all' adds all running jobs. Optional type filter applies before pagination.",
    promptSnippet: "List running or retained managed jobs",
    parameters: jobListSchema,
    executionMode: "parallel",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = manager.list(params as JobListInput, ctx.sessionManager.getSessionId());
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { operation: "job_list", list: result },
      };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", "job_list"), 0, 0);
    },
    renderResult(result, _options, theme) {
      return new Text(theme.fg("muted", compactDetails(result.details as JobToolDetails | undefined)), 0, 0);
    },
  });

  pi.registerTool({
    name: "job_stop",
    label: "Stop job",
    description:
      "Stop a managed job by ID. Stops descendants when the target is a parent. Idempotently returns an already-terminal job. JavaScript and local bash use SIGTERM then SIGKILL after five seconds; Herdr bash closes only its owned pane.",
    promptSnippet: "Stop a managed job and its descendants",
    parameters: jobStopSchema,
    executionMode: "parallel",
    async execute(_toolCallId, params) {
      const result = await manager.stop(params);
      return {
        content: [{ type: "text", text: jobText(result) }],
        details: { operation: "job_stop", job: result },
      };
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", `job_stop ${args.id}`), 0, 0);
    },
    renderResult(result, _options, theme) {
      return new Text(theme.fg("muted", compactDetails(result.details as JobToolDetails | undefined)), 0, 0);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
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
