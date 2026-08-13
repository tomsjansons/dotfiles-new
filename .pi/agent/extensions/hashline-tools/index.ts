/**
 * hashline-tools: snapshot-tagged reads, validated writes/edits, and a
 * jump pruner for old tool results.
 *
 * read  → emits `[path#TAG]` header + `N:` line prefixes; records a whole-file
 *         snapshot with seen-line provenance; self-expiring dedup stub.
 * write → unwraps `[path#TAG]` targets, strict-strips echoed prefixes, denies
 *         overwrite of out-of-band-drifted files, returns a fresh tag.
 * edit  → validates the tag against the store (deny on stale/expired), enforces
 *         seen-lines (deny blind edits with the exact offset that fixes them),
 *         returns a fresh tag post-commit.
 * prune → opencode-style jump pruning of old tool results at the context seam.
 *
 * Kill switches: PI_HASHLINE_DISABLE (tool overrides), PI_PRUNE_DISABLE (pruner).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { executeBash, pendingBashComponent, settledBashComponent } from "./bash-render";
import { executeEdit } from "./edit";
import { registerPruner } from "./prune";
import { executeRead } from "./read";
import { executeWrite } from "./write";
import { parseHeaderLine, pendingComponent, settledComponent, shouldShowErrorDetail } from "./render";

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	filePath: Type.Optional(Type.String({ description: "Alias for path" })),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

const writeSchema = Type.Object({
	path: Type.String({ description: "file path (a [path#TAG] header from read output is accepted)" }),
	content: Type.String({ description: "file content" }),
});

const editSchema = Type.Object({
	path: Type.String({ description: "file path (pass the [path#TAG] header from read output to enable validation)" }),
	edits: Type.Array(
		Type.Object({ oldText: Type.String(), newText: Type.String() }),
	),
});

export default function (pi: ExtensionAPI) {
	if (!process.env.PI_HASHLINE_DISABLE) {
		pi.registerTool({
			name: "read",
			label: "read (hashline)",
			description:
				"Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. " +
				"Text output is prefixed with a [path#TAG] header and N: line numbers; the TAG identifies the exact file version you saw — " +
				"pass the [path#TAG] header as the path when calling edit or write to validate against that version. " +
				"Output is truncated to 2000 lines or 50KB (whichever hits first), lines clamped to 2000 chars. Use offset/limit to page.",
			promptSnippet: "Read file contents",
			promptGuidelines: [
				"Use read to examine files instead of cat or sed.",
				"read output starts with a [path#TAG] header; pass that whole header as the edit/write path so the edit is validated against the exact version you saw.",
			],
			parameters: readSchema,
			renderShell: "self",

			// TUI-only: one-line status header, no background, no separator.
			renderCall(args, theme, ctx) {
				const path = (args.path ?? args.filePath ?? "").replace(/^@/, "");
				return pendingComponent(theme, "read", path, ctx.toolCallId);
			},
			renderResult(result, { expanded, isPartial }, theme, ctx) {
				const content = result.content[0];
				const fallbackPath = (ctx.args?.path ?? ctx.args?.filePath ?? "").replace(/^@/, "");
				if (content?.type === "image") {
					return settledComponent(theme, "read", "", "", fallbackPath || "(image)", "ok", 120, undefined, ctx.toolCallId, undefined, isPartial, ctx.invalidate);
				}
				if (content?.type !== "text") {
					return settledComponent(theme, "read", "", "", fallbackPath || "(no text)", "ok", 120, undefined, ctx.toolCallId, undefined, isPartial, ctx.invalidate);
				}
				const { path, tag } = parseHeaderLine(content.text);
				const lines = content.text.split("\n");
				const body = lines
					.filter((l) => !/^\[.*#[0-9A-F]{4}\]$/.test(l))
					.map((l) => l.replace(/^\d+:/, ""));
				const shown = body.join("\n");
				const errDet = shouldShowErrorDetail(ctx.isError, content.text) ? content.text : undefined;
				// Range: first-last displayed N: line numbers (from the prefixes).
				let range = "";
				const nums: number[] = [];
				for (const l of lines) {
					const m = l.match(/^(\d+):/);
					if (m) nums.push(Number(m[1]));
				}
				if (nums.length > 0) range = `${nums[0]}-${nums[nums.length - 1]}`;
				return settledComponent(
					theme,
					"read",
					range,
					tag ?? "",
					path || fallbackPath || "(unknown)",
					errDet ? "error" : "ok",
					120,
					expanded ? shown : undefined,
					ctx.toolCallId,
					errDet,
					isPartial,
					ctx.invalidate,
				);
			},
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				return executeRead(toolCallId, params, signal, onUpdate, ctx);
			},
		});

		pi.registerTool({
			name: "write",
			label: "write (hashline)",
			description:
				"Create or overwrite files. If the path is a [path#TAG] header from read output, the tag is validated before writing. " +
				"Successful writes return a fresh [path#TAG] header for immediate follow-up edits.",
			promptSnippet: "Create or overwrite files",
			promptGuidelines: ["Use write only for new files or complete rewrites."],
			parameters: writeSchema,
			renderShell: "self",
			renderCall(args, theme, ctx) {
				return pendingComponent(theme, "write", (args.path ?? "").replace(/^@/, ""), ctx.toolCallId);
			},
			renderResult(result, { expanded, isPartial }, theme, ctx) {
				const content = result.content.find((c): c is { type: "text"; text: string } => c.type === "text");
				const text = content?.text ?? "";
				const { path, tag } = parseHeaderLine(text);
				const error = shouldShowErrorDetail(ctx.isError, text);
				const fallbackPath = (ctx.args?.path ?? "").replace(/^@/, "");
				// Lines written: from the request payload.
				const written = ctx.args?.content ? ctx.args.content.split("\n").length : 0;
				const range = written > 0 ? `${written}L` : "";
				return settledComponent(
					theme,
					"write",
					range,
					tag ?? "",
					path || fallbackPath || "(unknown)",
					error ? "error" : "ok",
					120,
					expanded ? text : undefined,
					ctx.toolCallId,
					error ? text : undefined,
					isPartial,
					ctx.invalidate,
				);
			},
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				return executeWrite(toolCallId, params, signal, onUpdate, ctx);
			},
		});

		pi.registerTool({
			name: "edit",
			label: "edit (hashline)",
			description:
				"Make precise file edits with exact text replacement. Pass the [path#TAG] header from read output as the path: " +
				"edits are refused if the file changed since that tag was issued, or if they touch lines no read has shown you. " +
				"Successful edits return a fresh [path#TAG] header.",
			promptSnippet:
				"Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
			promptGuidelines: [
				"Use edit for precise changes (edits[].oldText must match exactly)",
				"When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
				"Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
				"Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
				"edit refuses to touch lines that no read has shown you yet; read the relevant range first when refused.",
			],
			parameters: editSchema,
			renderShell: "self",
			renderCall(args, theme, ctx) {
				return pendingComponent(theme, "edit", (args.path ?? "").replace(/^@/, ""), ctx.toolCallId);
			},
			renderResult(result, { expanded, isPartial }, theme, ctx) {
				const content = result.content.find((c): c is { type: "text"; text: string } => c.type === "text");
				const text = content?.text ?? "";
				const { path, tag } = parseHeaderLine(text);
				const error = shouldShowErrorDetail(ctx.isError, text);
				const fallbackPath = (ctx.args?.path ?? "").replace(/^@/, "");
				// Added/removed lines from the diff, styled green (+N) / red (-M).
				let range = "";
				const diff = (result.details as any)?.diff as string | undefined;
				if (diff && !error) {
					let added = 0;
					let removed = 0;
					for (const l of diff.split("\n")) {
						if (l.startsWith("+") && !l.startsWith("++")) added++;
						else if (l.startsWith("-") && !l.startsWith("--")) removed++;
					}
					const parts: string[] = [];
					if (added > 0) parts.push(theme.fg("success", `+${added}L`));
					if (removed > 0) parts.push(theme.fg("error", `-${removed}L`));
					range = parts.join(" ");
				}
				return settledComponent(
					theme,
					"edit",
					range,
					tag ?? "",
					path || fallbackPath || "(unknown)",
					error ? "error" : "ok",
					120,
					expanded ? text : undefined,
					ctx.toolCallId,
					error ? text : undefined,
					isPartial,
					ctx.invalidate,
				);
			},
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				return executeEdit(toolCallId, params, signal, onUpdate, ctx);
			},
		});
	}

	// Bash: compact hashline-style multi-line rendering + faithful local exec.
	// Overrides the built-in bash tool by name (extension tools win over built-ins).
	if (!process.env.PI_HASHLINE_DISABLE) {
		pi.registerTool({
			name: "bash",
			label: "bash",
			description:
				"Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.",
			promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
			promptGuidelines: ["You can inspect PI_* environment variables for current model and session details."],
			parameters: Type.Object({
				command: Type.String({ description: "Bash command to execute" }),
				timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
			}),
			renderShell: "self",

			renderCall(args, theme, ctx) {
				// Mirror the built-in bash: mark execution start on the shared renderer state.
				const state = ctx.state as { startedAt?: number; endedAt?: number; interval?: NodeJS.Timeout };
				if (ctx.executionStarted && state.startedAt === undefined) {
					state.startedAt = Date.now();
					state.endedAt = undefined;
				}
				return pendingBashComponent(theme, args.command ?? "", ctx.toolCallId);
			},
			renderResult(result, { expanded, isPartial }, theme, ctx) {
				const state = ctx.state as { startedAt?: number; endedAt?: number };
				if (isPartial) {
					// Keep the spinner (renderCall's pending line) animating — don't
					// settle the header or append a body yet. animateSpinner/stopSpinner
					// inside settledBashComponent drive the animation.
					return settledBashComponent(theme, result, ctx.args?.command ?? "", false, undefined, ctx.toolCallId, "", true, ctx.invalidate);
				}
				if (state.startedAt !== undefined) {
					state.endedAt ??= Date.now();
				}
				const elapsed = state.startedAt !== undefined ? (state.endedAt ?? Date.now()) - state.startedAt : undefined;
				// Pass context.isError explicitly: renderResult only receives { content, details }.
				return settledBashComponent(theme, { ...result, isError: ctx.isError }, ctx.args?.command ?? "", expanded, elapsed, ctx.toolCallId);
			},
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				return executeBash(toolCallId, params, signal, onUpdate, ctx);
			},
		});
	}

	registerPruner(pi);
}
