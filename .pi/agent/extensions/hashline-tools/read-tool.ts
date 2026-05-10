import { access, readFile } from "node:fs/promises";

import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	createReadTool,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";

import { buildHashlinePreview, isImagePath, normalizePath, resolvePath } from "./hashline.ts";

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

type ToolStatus = "pending" | "done" | "error";
const ROW_PREFIX = "    ";
const READ_ICON = "↑";
function colorReadIcon(icon: string): string {
	return `\x1b[38;2;135;206;250m${icon}\x1b[39m`;
}

function statusIcon(status: ToolStatus, theme: any): string {
	switch (status) {
		case "pending":
			return theme.fg("warning", "●");
		case "done":
			return theme.fg("success", "✓");
		case "error":
			return theme.fg("error", "✗");
	}
}

function formatReadRange(args: unknown, theme: any): string {
	const offset = (args as any)?.offset;
	const limit = (args as any)?.limit;
	if (offset === undefined && limit === undefined) return "";

	const start = typeof offset === "number" ? offset : 1;
	const end = typeof limit === "number" ? start + limit - 1 : undefined;
	return theme.fg("muted", end === undefined ? `:${start}` : `:${start}-${end}`);
}

function formatReadRow(status: ToolStatus, args: unknown, theme: any, message?: string): string {
	const rawPath = typeof (args as any)?.path === "string" ? normalizePath((args as any).path) : "<unknown>";
	let text = `${ROW_PREFIX}${statusIcon(status, theme)} ${colorReadIcon(READ_ICON)} ${theme.fg("accent", rawPath)}${formatReadRange(args, theme)}`;
	if (message) text += ` ${theme.fg(status === "error" ? "error" : "muted", message)}`;
	return text;
}

function emptyToolRow(): Text {
	return new Text("", 0, 0);
}

function firstTextLine(result: AgentToolResult<any>): string | undefined {
	const content = result.content[0];
	if (content?.type !== "text") return undefined;
	return content.text.split("\n")[0];
}

export function registerReadTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "read",
		label: "read",
		description:
			"Read file contents with LINE#ID hash anchors. Text files are returned as LINE#ID:content so later edit calls can target exact lines and fail safely if the file changed since it was read. Images are handled like the built-in read tool.",
		promptSnippet: "Read file contents with LINE#ID hash anchors",
		promptGuidelines: [
			"Use read to examine files instead of cat or sed.",
			"Hashline read prefixes each text line as LINE#ID:content. Copy LINE#ID anchors exactly when using edit.",
			"If a hashline edit fails because anchors changed, re-read the file and retry with the updated LINE#ID values.",
		],
		parameters: readSchema,
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const path = normalizePath(params.path);
			const absolutePath = resolvePath(ctx.cwd, path);

			if (isImagePath(path)) {
				const imageRead = createReadTool(ctx.cwd);
				return imageRead.execute(toolCallId, { ...params, path }, signal);
			}

			if (signal?.aborted) throw new Error("Operation aborted");
			await access(absolutePath);
			const raw = await readFile(absolutePath, "utf8");
			if (signal?.aborted) throw new Error("Operation aborted");

			const preview = buildHashlinePreview(raw, { offset: params.offset, limit: params.limit });
			const truncation = truncateHead(preview.anchored, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			const result: AgentToolResult<{ truncation?: typeof truncation }> = {
				content: [{ type: "text", text: truncation.content }],
				details: truncation.truncated ? { truncation } : {},
			};
			return result;
		},
		renderCall(args, theme, context) {
			if (!context.isPartial) return emptyToolRow();
			return new Text(formatReadRow("pending", args, theme), 0, 0);
		},
		renderResult(result, { isPartial }, theme, context) {
			if (isPartial) return new Text(formatReadRow("pending", context.args, theme), 0, 0);
			if (context.isError) {
				return new Text(formatReadRow("error", context.args, theme, firstTextLine(result)), 0, 0);
			}
			return new Text(formatReadRow("done", context.args, theme), 0, 0);
		},
		renderShell: "self",
	});
}
