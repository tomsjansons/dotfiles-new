import type { JobListResult, JobSnapshot } from "@dotfiles/job-runtime";
import { Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export type JobToolDetails = {
  operation: "job" | "job_list" | "job_stop";
  job?: JobSnapshot;
  list?: JobListResult;
};

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

export function emptyToolRow(): Text {
  return new Text("", 0, 0);
}

export function firstTextLine(result: any): string | undefined {
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

export function renderJobRow(
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
      const fullPrefixWidth = visibleWidth(COMMAND_PREFIX);
      const prefixWidth = Math.min(fullPrefixWidth, Math.max(0, maxWidth - 1));
      const commandPrefix = COMMAND_PREFIX.slice(0, prefixWidth);
      const commandWidth = Math.max(1, maxWidth - prefixWidth);
      for (const sourceLine of args.cmd.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
        if (sourceLine === "") {
          lines.push(commandPrefix);
          continue;
        }
        for (const wrapped of wrapTextWithAnsi(theme.fg("accent", sourceLine), commandWidth)) {
          const line = `${commandPrefix}${wrapped}`;
          if (visibleWidth(line) <= maxWidth) lines.push(line);
          else if (visibleWidth(wrapped) <= maxWidth) lines.push(wrapped);
          else lines.push(truncateToWidth(wrapped, maxWidth, ""));
        }
      }
      return lines;
    },
  };
}

export function renderSummaryRow(text: string, status: ToolStatus, theme: any): Text {
  return new Text(`${ROW_PREFIX}${statusIcon(status, theme)} ${theme.fg("toolTitle", text)}`, 0, 0);
}

export function listSummary(details: JobToolDetails | undefined): string {
  if (!details?.list) return "job_list";
  return `job_list ${details.list.running.length} running ${details.list.nonRunningCount} non-running`;
}
