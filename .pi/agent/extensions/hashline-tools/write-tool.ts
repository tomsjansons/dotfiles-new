import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";

import { normalizePath, resolvePath, stripHashlinePrefixesFromText } from "./hashline.ts";
import {
	countTextLines,
	countTextWords,
	progressSummary,
	type WriteProgress,
	writeTextWithProgress,
} from "./progress.ts";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

type ToolStatus = "pending" | "done" | "error";

const ROW_PREFIX = "    ";
const WRITE_ICON = "⇊";

function statusIcon(status: ToolStatus, theme: any): string {
	if (status === "pending") return theme.fg("warning", "●");
	if (status === "done") return theme.fg("success", "✓");
	return theme.fg("error", "✗");
}

function colorWriteIcon(icon: string): string {
	return `\x1b[38;2;255;255;0m${icon}\x1b[39m`;
}

type TextTotals = {
	lines: number;
	words: number;
};

function countWrittenTotals(args: unknown): TextTotals | undefined {
	const content = typeof (args as any)?.content === "string" ? stripHashlinePrefixesFromText((args as any).content) : undefined;
	if (content === undefined) return undefined;
	return { lines: countTextLines(content), words: countTextWords(content) };
}

function totalsFromProgress(progress: WriteProgress): TextTotals {
	return { lines: progress.totalLines, words: progress.totalWords };
}

function formatTextTotals(totals: TextTotals | undefined, theme: any): string {
	if (!totals) return "";
	return theme.fg(
		"muted",
		` ${totals.lines} line${totals.lines === 1 ? "" : "s"} ${totals.words} word${totals.words === 1 ? "" : "s"}`,
	);
}

function extractProgress(result: { details?: unknown }): WriteProgress | undefined {
	const progress = (result.details as any)?.progress;
	return progress && typeof progress === "object" ? (progress as WriteProgress) : undefined;
}

function formatWriteRow(
	status: ToolStatus,
	args: unknown,
	theme: any,
	totals?: TextTotals,
	message?: string,
	progress?: WriteProgress,
): string {
	const rawPath = typeof (args as any)?.path === "string" ? normalizePath((args as any).path) : "<unknown>";
	const stats = formatTextTotals(progress ? totalsFromProgress(progress) : totals, theme);
	let text = `${ROW_PREFIX}${statusIcon(status, theme)} ${colorWriteIcon(WRITE_ICON)} ${theme.fg("accent", rawPath)}${stats}`;
	if (message) text += ` ${theme.fg(status === "error" ? "error" : "muted", message)}`;
	return text;
}

function emptyToolRow(): Text {
	return new Text("", 0, 0);
}

function firstTextLine(result: AgentToolResult<unknown>): string | undefined {
	const content = result.content[0];
	if (content?.type !== "text") return undefined;
	return content.text.split("\n")[0];
}

export function registerWriteTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories. If the content accidentally includes copied LINE#ID: prefixes from hashline reads, they are stripped before writing.",
		promptSnippet: "Create or overwrite files",
		promptGuidelines: [
			"Use write only for new files or complete rewrites.",
			"If writing content copied from hashline read output, LINE#ID prefixes are stripped automatically.",
		],
		parameters: writeSchema,
		renderShell: "self",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const path = normalizePath(params.path);
			const content = stripHashlinePrefixesFromText(params.content);
			const absolutePath = resolvePath(ctx.cwd, path);

			return withFileMutationQueue(absolutePath, async () => {
				if (signal?.aborted) throw new Error("Operation aborted");
				await mkdir(dirname(absolutePath), { recursive: true });
				if (signal?.aborted) throw new Error("Operation aborted");

				const progress = await writeTextWithProgress(absolutePath, content, signal, (progress) => {
					onUpdate?.({
						content: [{ type: "text" as const, text: `Writing ${path}: ${progressSummary(progress)}` }],
						details: { progress },
					});
				});

				if (signal?.aborted) throw new Error("Operation aborted");
				return {
					content: [{ type: "text" as const, text: `Successfully wrote ${content.length} bytes to ${path}` }],
					details: { progress },
				};
			});
		},
		renderCall(args, theme, context) {
			if (!context.isPartial) return emptyToolRow();
			return new Text(formatWriteRow("pending", args, theme, countWrittenTotals(args)), 0, 0);
		},
		renderResult(result, { isPartial }, theme, context) {
			const progress = extractProgress(result);
			const totals = countWrittenTotals(context.args);
			if (isPartial) return new Text(formatWriteRow("pending", context.args, theme, totals, undefined, progress), 0, 0);

			if (context.isError) {
				return new Text(formatWriteRow("error", context.args, theme, totals, firstTextLine(result), progress), 0, 0);
			}

			return new Text(formatWriteRow("done", context.args, theme, totals, undefined, progress), 0, 0);
		},
	});
}
