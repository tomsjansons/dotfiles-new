import type { AgentToolResult, BashToolDetails, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool, formatSize } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";

const ROW_PREFIX = "    ";
const BASH_ICON = "○";


type ToolStatus = "pending" | "done" | "error";

function statusIcon(status: ToolStatus, theme: any): string {
	if (status === "pending") return theme.fg("warning", "●");
	if (status === "done") return theme.fg("success", "✓");
	return theme.fg("error", "✗");
}

function commandLines(command: unknown): string[] {
	if (typeof command !== "string") return ["command unavailable"];
	const lines = command.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	return lines.length > 0 ? lines.map((line) => line.replace(/[ \t]+$/g, "")) : [""];
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

function wrapCommandLine(line: string, firstWidth: number, continuationWidth: number): string[] {
	if (line === "") return [""];

	const wrappedLines: string[] = [];
	let remaining = line;
	let width = Math.max(1, firstWidth);

	while (visibleWidth(remaining) > width) {
		let end = 0;
		let lastWhitespace = -1;
		for (let index = 0; index < remaining.length; index += 1) {
			const candidate = remaining.slice(0, index + 1);
			if (visibleWidth(candidate) > width) break;
			end = index + 1;
			if (/\s/.test(remaining[index])) lastWhitespace = index;
		}

		const splitAt = lastWhitespace > 0 ? lastWhitespace : Math.max(1, end);
		wrappedLines.push(remaining.slice(0, splitAt).replace(/[ \t]+$/g, ""));
		remaining = remaining.slice(splitAt).replace(/^[ \t]+/g, "");
		width = Math.max(1, continuationWidth);
	}

	wrappedLines.push(remaining);
	return wrappedLines;
}

function formatCommand(command: unknown, theme: any, firstPrefix: string, continuationPrefix: string, maxWidth?: number): string {
	const width = typeof maxWidth === "number" ? Math.max(1, maxWidth) : 120;
	const renderedLines: string[] = [];

	for (const [lineIndex, line] of commandLines(command).entries()) {
		const firstSegmentPrefix = lineIndex === 0 ? firstPrefix : continuationPrefix;
		const firstWidth = Math.max(1, width - visibleWidth(firstSegmentPrefix));
		const continuationWidth = Math.max(1, width - visibleWidth(continuationPrefix));
		const wrapped = wrapCommandLine(line, firstWidth, continuationWidth);
		for (const [wrappedIndex, wrappedLine] of wrapped.entries()) {
			const prefix = lineIndex === 0 && wrappedIndex === 0 ? firstPrefix : continuationPrefix;
			renderedLines.push(`${prefix}${theme.fg("accent", wrappedLine)}`);
		}
	}

	return renderedLines.join("\n");
}

function formatBashRow(
	status: ToolStatus,
	args: unknown,
	theme: any,
	stats = "",
	message?: string,
	maxWidth?: number,
): string {
	const prefix = `${ROW_PREFIX}${statusIcon(status, theme)} ${theme.fg("toolTitle", BASH_ICON)} `;
	let suffix = stats;
	if (typeof (args as any)?.timeout === "number") suffix += theme.fg("muted", ` timeout=${(args as any).timeout}s`);
	if (message) suffix += ` ${theme.fg(status === "error" ? "error" : "muted", message)}`;

	const firstLineWidth = typeof maxWidth === "number" ? Math.max(1, maxWidth - visibleWidth(suffix)) : undefined;
	const continuationPrefix = `${ROW_PREFIX}  `;
	const command = formatCommand((args as any)?.command, theme, prefix, continuationPrefix, firstLineWidth);
	return `${command}${suffix}`;
}

function renderToolText(renderText: (width: number) => string): any {
	return {
		invalidate() {},
		render(width: number): string[] {
			const maxWidth = Math.max(1, width);
			return renderText(maxWidth).split("\n");
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
			return (bash.execute as any)(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, context) {
			if (context.executionStarted || !context.isPartial) return emptyToolRow();
			return renderToolText((width) => formatBashRow("pending", args, theme, "", undefined, width));
		},
		renderResult(result, { isPartial }, theme, context) {
			const typedResult = result as AgentToolResult<BashToolDetails | undefined>;
			const rawOutput = getTextOutput(typedResult);
			const showStats = !isPartial || rawOutput !== "" || Boolean(typedResult.details?.truncation?.truncated);
			const stats = showStats ? formatOutputStats(typedResult, theme) : "";

			if (isPartial) {
				return renderToolText((width) => formatBashRow("pending", context.args, theme, stats, undefined, width));
			}

			if (context.isError) {
				return renderToolText((width) =>
					formatBashRow(
						"error",
						context.args,
						theme,
						stats,
						firstTextLine(typedResult),
						width,
					),
				);
			}

			return renderToolText((width) => formatBashRow("done", context.args, theme, stats, undefined, width));
		},
	});
}
