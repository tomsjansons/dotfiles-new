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
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { executeEdit } from "./edit";
import { registerPruner } from "./prune";
import { executeRead } from "./read";
import { executeWrite } from "./write";

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

			// TUI-only renderer: strip hashline prefixes + header for display, so
			// the terminal preview shows clean file text. Model output untouched.
			renderResult(result, { expanded }, theme) {
				const content = result.content[0];
				if (content?.type === "image") {
					return new Text(theme.fg("success", "Image loaded"), 0, 0);
				}
				if (content?.type !== "text") {
					return new Text(theme.fg("dim", "(no text)"), 0, 0);
				}
				// Drop the [path#TAG] header line and N: prefixes, keep clamp/truncation notes.
				const lines = content.text.split("\n");
				const body = lines
					.filter((l) => !/^\[.*#[0-9A-F]{4}\]$/.test(l))
					.map((l) => l.replace(/^\d+:/, ""));
				const shown = body.join("\n");
				const lineCount = shown.split("\n").length;
				const truncated =
					(result.details as any)?.truncation?.truncated || /Use offset=\d+ to continue/.test(content.text);
				let header = theme.fg("success", `${lineCount} lines`);
				if (truncated) header += theme.fg("warning", " (truncated)");
				if (expanded) {
					return new Text(`${header}\n\n${shown}`, 0, 0);
				}
				return new Text(header, 0, 0);
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
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				return executeEdit(toolCallId, params, signal, onUpdate, ctx);
			},
		});
	}

	registerPruner(pi);
}
