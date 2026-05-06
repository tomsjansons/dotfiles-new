import { execFile } from "node:child_process";
import type { AgentToolResult, BashToolDetails, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createBashTool, formatSize } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const ROW_PREFIX = "    ";
const BASH_ICON = "○";
const MAX_COMMAND_CHARS = 96;
const MAX_SUMMARY_CHARS = 64;
const ERROR_SUMMARY_LEFT_PADDING = "        ";
const SUMMARY_FAILURE_LEFT_PADDING = "        ";
const COMMAND_SUMMARY_PREFIX = "[pi bash command summary]:";
const COMMAND_SUMMARY_ERROR_PREFIX = "[pi bash command summary error]:";
const ERROR_SUMMARY_PREFIX = "[pi bash error summary]:";
const ERROR_SUMMARY_ERROR_PREFIX = "[pi bash error summary error]:";

type ToolStatus = "pending" | "done" | "error";

function statusIcon(status: ToolStatus, theme: any): string {
	if (status === "pending") return theme.fg("warning", "●");
	if (status === "done") return theme.fg("success", "✓");
	return theme.fg("error", "✗");
}

function normalizeCommand(command: unknown): string {
	if (typeof command !== "string") return "<unknown>";
	return command
		.replace(/\r?\n/g, " ⏎ ")
		.replace(/\s+/g, " ")
		.trim();
}

function shorten(text: string, maxChars = MAX_COMMAND_CHARS): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function getTextOutput(result: AgentToolResult<BashToolDetails | undefined>): string {
	const content = result.content[0];
	return content?.type === "text" ? content.text : "";
}

function stripBashNotices(output: string): string {
	return output
		.replace(/\n\n\[Showing[\s\S]*$/m, "")
		.replace(/\n\nCommand exited with code \d+[\s\S]*$/m, "")
		.replace(/\n\nCommand timed out after \d+ seconds[\s\S]*$/m, "")
		.replace(/\n\nCommand aborted[\s\S]*$/m, "")
		.replace(/\n+$/g, "");
}

function countOutputLines(output: string): number {
	if (output === "" || output === "(no output)") return 0;
	return output.split("\n").length;
}

function formatOutputStats(result: AgentToolResult<BashToolDetails | undefined>, theme: any): string {
	const truncation = result.details?.truncation;
	if (truncation?.truncated) {
		const omittedLines = Math.max(0, truncation.totalLines - truncation.outputLines);
		const lineStats = `${truncation.outputLines}/${truncation.totalLines} lines`;
		const sizeStats = `${formatSize(truncation.outputBytes)}/${formatSize(truncation.totalBytes)}`;
		const omitted = omittedLines > 0 ? `, ${omittedLines} truncated` : "";
		return theme.fg("muted", ` ${lineStats}, ${sizeStats}${omitted}`);
	}

	const output = stripBashNotices(getTextOutput(result));
	const lines = countOutputLines(output);
	const size = Buffer.byteLength(output, "utf8");
	return theme.fg("muted", ` ${lines} line${lines === 1 ? "" : "s"}, ${formatSize(size)}`);
}

type SummaryResult = { summary?: string; error?: string };
type BashDetailsWithSummary = (BashToolDetails & { commandSummary?: string; commandSummaryError?: string }) | undefined;

function firstNonEmptyLine(text: unknown): string | undefined {
	if (typeof text !== "string") return undefined;
	return text.split("\n").find((line) => line.trim() !== "")?.trim();
}

function formatSummaryProcessError(error: unknown, stderr: string, stdout: string): string {
	const err = error as { code?: unknown; signal?: unknown; killed?: boolean; message?: string };
	const stderrLine = firstNonEmptyLine(stderr);
	const stdoutLine = firstNonEmptyLine(stdout);

	if (err.code === "ENOENT") return "pi executable not found";
	if (err.code === "ETIMEDOUT") return "timed out after 10s";
	if (err.killed && err.signal === "SIGTERM") return "timed out after 10s or was killed";
	if (typeof err.code === "number") return `pi exited with code ${err.code}${stderrLine ? `: ${shorten(stderrLine, 160)}` : ""}`;
	if (stderrLine) return `pi failed: ${shorten(stderrLine, 160)}`;
	if (stdoutLine) return `pi failed: ${shorten(stdoutLine, 160)}`;
	if (err.message) return shorten(err.message.replace(/\s+/g, " "), 160);
	return "unknown failure";
}

function summarizeOneSentence(text: unknown, signal?: AbortSignal): Promise<SummaryResult> {
	if (typeof text !== "string" || text.trim() === "") return Promise.resolve({});

	return new Promise((resolve) => {
		const child = execFile(
			"pi",
			[
				"--model",
				"openai-codex/gpt-5.4-mini",
				"--thinking",
				"off",
				"--no-tools",
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
				"--no-session",
				"--offline",
				"-p",
				`Summarize this shell command in ${MAX_SUMMARY_CHARS} characters or fewer. Use plain text, no markdown, no backticks, no period. Command: ${text}`,
			],
			{ timeout: 10_000, maxBuffer: 16 * 1024, encoding: "utf8" },
			(error, stdout, stderr) => {
				if (error) {
					resolve({ error: formatSummaryProcessError(error, stderr, stdout) });
					return;
				}

				const summary = stdout.replace(/[`*_#]/g, "").replace(/\s+/g, " ").trim().replace(/[.。]+$/g, "");
				resolve(summary ? { summary: shorten(summary, MAX_SUMMARY_CHARS) } : { error: "pi produced no summary output" });
			},
		);
		child.stdin?.end();

		const abort = () => {
			child.kill();
			resolve({ error: "aborted" });
		};

		if (signal?.aborted) {
			abort();
			return;
		}

		signal?.addEventListener("abort", abort, { once: true });
		child.once("exit", () => signal?.removeEventListener("abort", abort));
	});
}

function attachCommandSummary(
result: AgentToolResult<BashToolDetails | undefined>,
summary: SummaryResult,
command: unknown,
fallbackToCommand: boolean,
 ): AgentToolResult<BashDetailsWithSummary> {
	const commandSummary = summary.summary ?? (fallbackToCommand ? normalizeCommand(command) : undefined);
	return {
		...result,
		details: { ...((result.details ?? {}) as BashToolDetails), commandSummary, commandSummaryError: summary.error },
	} as AgentToolResult<BashDetailsWithSummary>;
}

function appendBashSummariesToError(message: string, command: unknown, commandSummary: SummaryResult, errorSummary: SummaryResult): string {
	const summaries: string[] = [];
	const commandSummaryText = commandSummary.summary ?? normalizeCommand(command);
	if (commandSummaryText) summaries.push(`${COMMAND_SUMMARY_PREFIX} ${commandSummaryText}`);
	if (commandSummary.error) summaries.push(`${COMMAND_SUMMARY_ERROR_PREFIX} ${commandSummary.error}`);
	if (errorSummary.summary) summaries.push(`${ERROR_SUMMARY_PREFIX} ${errorSummary.summary}`);
	if (errorSummary.error) summaries.push(`${ERROR_SUMMARY_ERROR_PREFIX} ${errorSummary.error}`);
	return summaries.length > 0 ? `${message}\n\n${summaries.join("\n")}` : message;
}

function extractPrefixedLine(output: string, prefix: string): string | undefined {
	const line = output.split("\n").find((candidate) => candidate.startsWith(prefix));
	return line?.slice(prefix.length).trim() || undefined;
}

function formatErrorSummary(summary: string | undefined, theme: any): string {
	return summary ? `\n${ERROR_SUMMARY_LEFT_PADDING}${theme.fg("error", summary)}` : "";
}

function formatSummaryFailure(label: string, summaryError: string | undefined, theme: any): string {
	return summaryError ? `\n${SUMMARY_FAILURE_LEFT_PADDING}${theme.fg("warning", `${label} failed: ${summaryError}`)}` : "";
}

function formatBashRow(
	status: ToolStatus,
	args: unknown,
	theme: any,
	stats = "",
	message?: string,
	commandSummary?: string,
	maxWidth?: number,
 ): string {
	const fallbackCommand = normalizeCommand((args as any)?.command);
	const fallback = status === "pending" ? "summarizing command…" : fallbackCommand === "<unknown>" ? "command summary unavailable" : fallbackCommand;
	const rawCommand = commandSummary ?? fallback;
	const prefix = `${ROW_PREFIX}${statusIcon(status, theme)} ${theme.fg("toolTitle", BASH_ICON)} `;
	let suffix = stats;
	if (typeof (args as any)?.timeout === "number") suffix += theme.fg("muted", ` timeout=${(args as any).timeout}s`);
	if (message) suffix += ` ${theme.fg(status === "error" ? "error" : "muted", message)}`;

	const availableCommandWidth =
		typeof maxWidth === "number" ? Math.max(1, maxWidth - visibleWidth(prefix) - visibleWidth(suffix)) : MAX_COMMAND_CHARS;
	const command = truncateToWidth(rawCommand, Math.min(MAX_COMMAND_CHARS, availableCommandWidth), "…");
	return `${prefix}${theme.fg("accent", command)}${suffix}`;
}

function renderToolText(renderText: (width: number) => string): any {
	return {
		invalidate() {},
		render(width: number): string[] {
			const maxWidth = Math.max(1, width);
			return renderText(maxWidth)
				.split("\n")
				.map((line) => truncateToWidth(line, maxWidth, "…"));
		},
	};
}

function emptyToolRow(): Text {
	return new Text("", 0, 0);
}

function firstTextLine(result: AgentToolResult<BashToolDetails | undefined>): string | undefined {
	const output = stripBashNotices(getTextOutput(result));
	return output.split("\n").find((line) => line.trim() !== "");
}

export function registerBashTool(pi: ExtensionAPI): void {
	const metadataBash = createBashTool(process.cwd());

	pi.registerTool({
		name: "bash",
		label: "bash",
		description: metadataBash.description,
		promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
		parameters: metadataBash.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const bash = createBashTool(ctx.cwd);
			const command = (params as any)?.command;
			const commandSummaryPromise = summarizeOneSentence(command, signal);
			try {
				const bashResult = await (bash.execute as any)(toolCallId, params, signal, onUpdate, ctx);
				const commandSummary = await commandSummaryPromise;
				return attachCommandSummary(bashResult, commandSummary, command, true);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const [commandSummary, errorSummary] = await Promise.all([commandSummaryPromise, summarizeOneSentence(message, signal)]);
				throw new Error(appendBashSummariesToError(message, command, commandSummary, errorSummary));
			}
		},
		renderCall(args, theme, context) {
			if (!context.isPartial) return emptyToolRow();
			return renderToolText((width) => formatBashRow("pending", args, theme, "", undefined, undefined, width));
		},
		renderResult(result, { isPartial }, theme, context) {
			if (isPartial) return emptyToolRow();

			const typedResult = result as AgentToolResult<BashDetailsWithSummary>;
			const rawOutput = getTextOutput(result as AgentToolResult<BashToolDetails | undefined>);
			const stats = formatOutputStats(typedResult as AgentToolResult<BashToolDetails | undefined>, theme);
			const commandSummary = typedResult.details?.commandSummary ?? extractPrefixedLine(rawOutput, COMMAND_SUMMARY_PREFIX);
			const commandSummaryError = typedResult.details?.commandSummaryError ?? extractPrefixedLine(rawOutput, COMMAND_SUMMARY_ERROR_PREFIX);
			const errorSummary = extractPrefixedLine(rawOutput, ERROR_SUMMARY_PREFIX);
			const errorSummaryError = extractPrefixedLine(rawOutput, ERROR_SUMMARY_ERROR_PREFIX);
			if (context.isError) {
				return renderToolText(
					(width) =>
						formatBashRow(
							"error",
							context.args,
							theme,
							stats,
							firstTextLine(result as AgentToolResult<BashToolDetails | undefined>),
							commandSummary,
							width,
						) +
						formatErrorSummary(errorSummary, theme) +
						formatSummaryFailure("pi command summary", commandSummaryError, theme) +
						formatSummaryFailure("pi error summary", errorSummaryError, theme),
				);
			}

			return renderToolText(
				(width) =>
					formatBashRow("done", context.args, theme, stats, undefined, commandSummary, width) +
					formatSummaryFailure("pi command summary", commandSummaryError, theme),
			);
		},
	});
}
