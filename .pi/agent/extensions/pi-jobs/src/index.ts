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
import { Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
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

type ToolStatus = "pending" | "done" | "error";
const ROW_PREFIX = "    ";
const COMMAND_PREFIX = "      ";

function statusIcon(status: ToolStatus, theme: any): string {
  if (status === "pending") return theme.fg("warning", "●");
  if (status === "done") return theme.fg("success", "✓");
  return theme.fg("error", "✗");
}

function jobIcon(type: unknown, theme: any): string {
  return theme.fg(type === "bash" ? "warning" : "accent", "◆");
}

function emptyToolRow(): Text {
  return new Text("", 0, 0);
}

function firstTextLine(result: any): string | undefined {
  const content = result?.content?.find((entry: any) => entry?.type === "text");
  return content?.text?.split("\n").find((line: string) => line.trim() !== "");
}

function visualStatus(job: JobSnapshot | undefined, isError: boolean): ToolStatus {
  if (isError) return "error";
  if (!job || job.status === "starting" || job.status === "running") return "pending";
  return job.status === "completed" ? "done" : "error";
}

function formatJobHeader(
  args: any,
  details: JobToolDetails | undefined,
  isError: boolean,
  theme: any,
  message?: string,
): string {
  const job = details?.job;
  const type = job?.type ?? args?.type ?? "job";
  const mode = job?.mode ?? args?.mode ?? "sync";
  const status = visualStatus(job, isError);
  let text = `${ROW_PREFIX}${statusIcon(status, theme)} ${jobIcon(type, theme)} ${theme.fg("toolTitle", `${type}/${mode}`)}`;
  if (job?.id) text += ` ${theme.fg("muted", job.id)}`;
  if (job?.status) text += ` ${theme.fg(status === "error" ? "error" : "muted", job.status)}`;
  if (job?.durationMs !== undefined) text += theme.fg("muted", ` ${(job.durationMs / 1_000).toFixed(1)}s`);
  if (message) text += ` ${theme.fg("error", message)}`;
  return text;
}

function renderJobRow(
  args: any,
  details: JobToolDetails | undefined,
  isError: boolean,
  showCommand: boolean,
  theme: any,
  message?: string,
): any {
  return {
    invalidate() {},
    render(width: number): string[] {
      const maxWidth = Math.max(1, width);
      const lines = [truncateToWidth(formatJobHeader(args, details, isError, theme, message), maxWidth, "…")];
      if (!showCommand || typeof args?.cmd !== "string") return lines;
      const commandWidth = Math.max(1, maxWidth - visibleWidth(COMMAND_PREFIX));
      for (const sourceLine of args.cmd.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
        if (sourceLine === "") {
          lines.push(COMMAND_PREFIX);
          continue;
        }
        for (const wrapped of wrapTextWithAnsi(theme.fg("accent", sourceLine), commandWidth)) {
          lines.push(`${COMMAND_PREFIX}${wrapped}`);
        }
      }
      return lines;
    },
  };
}

function renderSummaryRow(text: string, status: ToolStatus, theme: any): Text {
  return new Text(`${ROW_PREFIX}${statusIcon(status, theme)} ${theme.fg("toolTitle", text)}`, 0, 0);
}

function listSummary(details: JobToolDetails | undefined): string {
  if (!details?.list) return "job_list";
  return `job_list ${details.list.running.length} running ${details.list.nonRunningCount} non-running`;
}

export default function piJobs(pi: ExtensionAPI): void {
  const manager = getGlobalJobManager();
  manager.providers.register(new JavaScriptJobProvider());
  let showJobDetails = false;

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
    renderCall(args, theme, context) {
      if (!context.isPartial) return emptyToolRow();
      return renderJobRow(args, undefined, false, showJobDetails, theme);
    },
    renderResult(result, { isPartial }, theme, context) {
      const details = result.details as JobToolDetails | undefined;
      return renderJobRow(
        context.args,
        details,
        context.isError,
        showJobDetails,
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

  const setBashToolActive = (active: boolean): void => {
    const activeTools = new Set(pi.getActiveTools());
    if (active) activeTools.add("bash");
    else activeTools.delete("bash");
    pi.setActiveTools([...activeTools]);
  };

  pi.registerCommand("job-details", {
    description: "Show or hide full JavaScript/bash commands in job tool rows: /job-details on|off",
    handler: async (args, ctx) => {
      const requested = args.trim().toLowerCase();
      if (requested !== "on" && requested !== "off") {
        ctx.ui.notify("Usage: /job-details on|off", "warning");
        return;
      }
      showJobDetails = requested === "on";
      ctx.ui.notify(`Job command details ${showJobDetails ? "enabled" : "disabled"}.`, "info");
    },
  });

  pi.registerCommand("bash-tool", {
    description: "Enable or disable the model-facing bash tool: /bash-tool on|off",
    handler: async (args, ctx) => {
      const requested = args.trim().toLowerCase();
      if (requested !== "on" && requested !== "off") {
        ctx.ui.notify("Usage: /bash-tool on|off", "warning");
        return;
      }
      const active = requested === "on";
      setBashToolActive(active);
      ctx.ui.notify(`Model-facing bash tool ${active ? "enabled" : "disabled"}.`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    setBashToolActive(false);
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
