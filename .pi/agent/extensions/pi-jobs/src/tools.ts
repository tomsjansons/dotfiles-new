import { basename } from "node:path";

import type {
  JobInvocationContext,
  JobListInput,
  JobManager,
  JobSnapshot,
  JobStartInput,
} from "@dotfiles/job-runtime";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  emptyToolRow,
  firstTextLine,
  listSummary,
  renderJobRow,
  renderSummaryRow,
  type JobToolDetails,
} from "./rendering.ts";
import { jobListSchema, jobSchema, jobStopSchema } from "./tool-schemas.ts";

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

export function registerJobTools(
  pi: ExtensionAPI,
  manager: JobManager,
  showJobDetails: () => boolean,
): void {
  pi.registerTool({
    name: "job",
    label: "Job",
    description:
      "Run a managed JavaScript or bash job. JavaScript cmd is an async function body: use top-level await and return output explicitly; console is unavailable. Both outer and nested JavaScript contexts expose job/job_list/job_stop. JavaScript has unrestricted dynamic imports, filesystem, and network (including fetch), but cannot spawn subprocesses directly. Bash jobs route to validated Herdr panes when available and otherwise run as managed local processes; both backends explicitly use bash -c. Sync returns bounded head/tail output plus outputPath; async returns immediately and only root async jobs notify on completion. Use read outside JavaScript or node:fs/promises inside JavaScript for full output. There are no job read/wait operations; compose Promise timers and job_list instead.",
    promptSnippet: "Run managed JavaScript or bash jobs synchronously or asynchronously",
    promptGuidelines: [
      "Use job with type 'bash' for model shell commands; the standalone bash tool is inactive by default and user-toggleable with /bash-tool on|off.",
      "Read complete job output from outputPath: use the normal read tool outside JavaScript or node:fs/promises inside it.",
      "Nested jobs never notify automatically; explicitly return child metadata/output paths when they should be surfaced.",
    ],
    renderShell: "self",
    parameters: jobSchema,
    executionMode: "parallel",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      let interval: NodeJS.Timeout | undefined;
      try {
        const result = await manager.start(
          params as JobStartInput,
          sessionContext(ctx, toolCallId),
          signal,
          (started) => {
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
      }
    },
    renderCall(args, theme, context) {
      if (!context.isPartial) return emptyToolRow();
      return renderJobRow(args, undefined, false, showJobDetails(), theme);
    },
    renderResult(result, { isPartial }, theme, context) {
      const details = result.details as JobToolDetails | undefined;
      return renderJobRow(
        context.args,
        details,
        context.isError,
        showJobDetails(),
        theme,
        !isPartial && context.isError ? firstTextLine(result) : undefined,
      );
    },
  });

  pi.registerTool({
    name: "job_list",
    label: "Job list",
    description:
      "List managed jobs. With no arguments, returns every running job plus the current session non-running count. include='non-running' returns the newest 50 terminal jobs and nextCursor; include='all' adds all running jobs. Optional type filter applies before pagination.",
    promptSnippet: "List running or retained managed jobs",
    parameters: jobListSchema,
    renderShell: "self",
    executionMode: "parallel",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = manager.list(params as JobListInput, ctx.sessionManager.getSessionId());
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { operation: "job_list", list: result },
      };
    },
    renderCall(_args, theme, context) {
      if (!context.isPartial) return emptyToolRow();
      return renderSummaryRow("job_list", "pending", theme);
    },
    renderResult(result, { isPartial }, theme, context) {
      return renderSummaryRow(
        listSummary(result.details as JobToolDetails | undefined),
        context.isError ? "error" : isPartial ? "pending" : "done",
        theme,
      );
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
    renderShell: "self",
    async execute(_toolCallId, params) {
      const result = await manager.stop(params);
      return {
        content: [{ type: "text", text: jobText(result) }],
        details: { operation: "job_stop", job: result },
      };
    },
    renderCall(args, theme, context) {
      if (!context.isPartial) return emptyToolRow();
      return renderSummaryRow(`job_stop ${args.id}`, "pending", theme);
    },
    renderResult(result, { isPartial }, theme, context) {
      const details = result.details as JobToolDetails | undefined;
      return renderJobRow(
        { type: details?.job?.type, mode: details?.job?.mode },
        details,
        context.isError,
        false,
        theme,
        !isPartial && context.isError ? firstTextLine(result) : undefined,
      );
    },
  });
}
