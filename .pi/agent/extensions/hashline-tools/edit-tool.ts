import { access, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { EditToolDetails, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@earendil-works/pi-tui";

import {
	computeLineHash,
	detectLineEnding,
	formatHashLine,
	normalizePath,
	normalizeToLF,
	resolvePath,
	restoreLineEndings,
	stripBom,
	stripHashlinePrefix,
	textToLines,
} from "./hashline.ts";
import { countTextWords, progressSummary, type WriteProgress, writeTextWithProgress } from "./progress.ts";

const HASHLINE_RE = /^\s*(\d+)\s*#\s*([ZPMQVRWSNKTXJBYH]{2})/;

const editItemSchema = Type.Object(
	{
		loc: Type.Any({
			description:
				'Hashline location: "append", "prepend", { append: "LINE#ID" }, { prepend: "LINE#ID" }, or { range: { pos: "LINE#ID", end: "LINE#ID" } }.',
		}),
		content: Type.Any({
			description: "Replacement/inserted lines. Usually an array of strings, one output line per array entry.",
		}),
	},
	{
		additionalProperties: false,
		description: "Hashline edit block: { loc, content }.",
	},
);

const editSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
		edits: Type.Array(editItemSchema, {
			description:
				"Batch all edits for one file into a single call. Always copy LINE#ID anchors exactly from the most recent read output.",
		}),
	},
	{ additionalProperties: false },
);

type Anchor = {
	line: number;
	hash: string;
};

type HashlineMismatch = {
	line: number;
	expected: string;
	actual?: string;
	missing?: boolean;
};

type ParsedEditOperation = {
	kind: "append" | "prepend" | "insertAfter" | "insertBefore" | "replaceRange";
	contentLines: string[];
	oldStartIndex: number;
	oldEndIndex: number;
	priority: number;
	sortLine: number;
	description: string;
};

function sanitizeContentLine(line: string): string {
	const withoutPrefix = stripHashlinePrefix(line.replace(/\r$/, ""));
	const escapedTabs = withoutPrefix.match(/^(?:\\t)+/);
	if (!escapedTabs) return withoutPrefix;
	return "\t".repeat(escapedTabs[0].length / 2) + withoutPrefix.slice(escapedTabs[0].length);
}

function normalizeContentLines(content: unknown): string[] {
	if (Array.isArray(content)) {
		return content.map((line) => sanitizeContentLine(String(line)));
	}
	if (typeof content === "string") {
		return content.split("\n").map((line) => sanitizeContentLine(line));
	}
	throw new Error("Each edit.content must be a string array (or a newline-delimited string).");
}

function parseAnchor(value: string): Anchor {
	const match = value.match(HASHLINE_RE);
	if (!match) {
		throw new Error(`Invalid LINE#ID anchor: ${JSON.stringify(value)}. Expected a value like \"12#RZ\" copied from read output.`);
	}
	const line = Number(match[1]);
	if (!Number.isInteger(line) || line <= 0) {
		throw new Error(`Invalid anchor line number in ${JSON.stringify(value)}.`);
	}
	return { line, hash: match[2] };
}

function validateAnchor(anchor: Anchor, fileLines: string[], mismatches: HashlineMismatch[]): void {
	const current = fileLines[anchor.line - 1];
	if (current === undefined) {
		mismatches.push({ line: anchor.line, expected: anchor.hash, missing: true });
		return;
	}
	const actual = computeLineHash(anchor.line, current);
	if (actual !== anchor.hash) {
		mismatches.push({ line: anchor.line, expected: anchor.hash, actual });
	}
}

function renderMismatchContext(fileLines: string[], mismatchLine: number): string {
	if (fileLines.length === 0) {
		return "    [file is currently empty]";
	}

	const start = Math.max(1, mismatchLine - 1);
	const end = Math.min(fileLines.length, mismatchLine + 1);
	const lines: string[] = [];
	for (let line = start; line <= end; line++) {
		const marker = line === mismatchLine ? ">>>" : "   ";
		lines.push(`${marker} ${formatHashLine(line, fileLines[line - 1])}`);
	}
	if (mismatchLine > fileLines.length) {
		lines.push(`>>> line ${mismatchLine} no longer exists`);
	}
	return lines.join("\n");
}

function formatMismatchError(mismatches: HashlineMismatch[], fileLines: string[]): string {
	const uniqueLines = [...new Set(mismatches.map((m) => m.line))].sort((a, b) => a - b);
	const label = uniqueLines.length === 1 ? "line has" : "lines have";
	const sections = uniqueLines.map((line) => renderMismatchContext(fileLines, line)).join("\n\n");
	return `${uniqueLines.length} ${label} changed since the last read. Use the updated LINE#ID references shown below (>>> marks changed lines).\n\n${sections}`;
}

function dedupeOperations(operations: ParsedEditOperation[]): ParsedEditOperation[] {
	const seen = new Set<string>();
	const result: ParsedEditOperation[] = [];
	for (const operation of operations) {
		const key = JSON.stringify({
			kind: operation.kind,
			contentLines: operation.contentLines,
			oldStartIndex: operation.oldStartIndex,
			oldEndIndex: operation.oldEndIndex,
		});
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(operation);
	}
	return result;
}

function assertNoOverlappingRangeReplacements(operations: ParsedEditOperation[]): void {
	const ranges = operations
		.filter((operation) => operation.kind === "replaceRange")
		.sort((a, b) => a.oldStartIndex - b.oldStartIndex);

	for (let i = 1; i < ranges.length; i++) {
		const previous = ranges[i - 1];
		const current = ranges[i];
		if (current.oldStartIndex < previous.oldEndIndex) {
			throw new Error(
				`Overlapping range edits are not allowed. ${previous.description} overlaps ${current.description}. Merge them into one range edit.`,
			);
		}
	}
}

function parseHashlineOperations(rawEdits: unknown[], fileLines: string[]): ParsedEditOperation[] {
	const mismatches: HashlineMismatch[] = [];
	const operations: ParsedEditOperation[] = [];

	for (const rawEdit of rawEdits) {
		if (!rawEdit || typeof rawEdit !== "object") {
			throw new Error("Each edit must be an object.");
		}

		const loc = (rawEdit as any).loc;
		const contentLines = normalizeContentLines((rawEdit as any).content);

		if (loc === "append") {
			operations.push({
				kind: "append",
				contentLines,
				oldStartIndex: fileLines.length,
				oldEndIndex: fileLines.length,
				priority: 4,
				sortLine: fileLines.length + 1,
				description: "append",
			});
			continue;
		}

		if (loc === "prepend") {
			operations.push({
				kind: "prepend",
				contentLines,
				oldStartIndex: 0,
				oldEndIndex: 0,
				priority: 0,
				sortLine: 0,
				description: "prepend",
			});
			continue;
		}

		if (!loc || typeof loc !== "object") {
			throw new Error(
				"Each hashline edit must provide loc as one of: \"append\", \"prepend\", { append: \"LINE#ID\" }, { prepend: \"LINE#ID\" }, or { range: { pos: \"LINE#ID\", end: \"LINE#ID\" } }.",
			);
		}

		if (typeof (loc as any).append === "string") {
			const anchor = parseAnchor((loc as any).append);
			validateAnchor(anchor, fileLines, mismatches);
			operations.push({
				kind: "insertAfter",
				contentLines,
				oldStartIndex: anchor.line,
				oldEndIndex: anchor.line,
				priority: 2,
				sortLine: anchor.line,
				description: `insert after ${anchor.line}#${anchor.hash}`,
			});
			continue;
		}

		if (typeof (loc as any).prepend === "string") {
			const anchor = parseAnchor((loc as any).prepend);
			validateAnchor(anchor, fileLines, mismatches);
			operations.push({
				kind: "insertBefore",
				contentLines,
				oldStartIndex: anchor.line - 1,
				oldEndIndex: anchor.line - 1,
				priority: 1,
				sortLine: anchor.line,
				description: `insert before ${anchor.line}#${anchor.hash}`,
			});
			continue;
		}

		const range = (loc as any).range;
		if (range && typeof range === "object" && typeof range.pos === "string" && typeof range.end === "string") {
			const start = parseAnchor(range.pos);
			const end = parseAnchor(range.end);
			if (end.line < start.line) {
				throw new Error(`Invalid range ${range.pos}..${range.end}: end must be on or after start.`);
			}
			validateAnchor(start, fileLines, mismatches);
			if (end.line !== start.line || end.hash !== start.hash) {
				validateAnchor(end, fileLines, mismatches);
			}
			operations.push({
				kind: "replaceRange",
				contentLines,
				oldStartIndex: start.line - 1,
				oldEndIndex: end.line,
				priority: 3,
				sortLine: end.line,
				description: `replace ${start.line}#${start.hash}..${end.line}#${end.hash}`,
			});
			continue;
		}

		throw new Error(
			"Unsupported hashline edit loc. Use \"append\", \"prepend\", { append: \"LINE#ID\" }, { prepend: \"LINE#ID\" }, or { range: { pos: \"LINE#ID\", end: \"LINE#ID\" } }.",
		);
	}

	if (mismatches.length > 0) {
		throw new Error(formatMismatchError(mismatches, fileLines));
	}

	const deduped = dedupeOperations(operations);
	assertNoOverlappingRangeReplacements(deduped);
	return deduped;
}

function operationSortValue(operation: ParsedEditOperation): number {
	return operation.sortLine * 10 + operation.priority;
}

function applyOperations(originalLines: string[], operations: ParsedEditOperation[]): string[] {
	const lines = [...originalLines];
	const sorted = [...operations].sort((a, b) => operationSortValue(b) - operationSortValue(a));

	for (const operation of sorted) {
		switch (operation.kind) {
			case "append":
				lines.splice(lines.length, 0, ...operation.contentLines);
				break;
			case "prepend":
				lines.splice(0, 0, ...operation.contentLines);
				break;
			case "insertAfter":
				lines.splice(operation.oldStartIndex, 0, ...operation.contentLines);
				break;
			case "insertBefore":
				lines.splice(operation.oldStartIndex, 0, ...operation.contentLines);
				break;
			case "replaceRange":
				lines.splice(
					operation.oldStartIndex,
					operation.oldEndIndex - operation.oldStartIndex,
					...operation.contentLines,
				);
				break;
		}
	}

	return lines;
}

type ToolStatus = "pending" | "done" | "error";
const ROW_PREFIX = "    ";
const EDIT_ICON = "↓";
function colorEditIcon(icon: string): string {
	return `\x1b[38;2;255;255;0m${icon}\x1b[39m`;
}

type TextTotals = {
	lines: number;
	words: number;
};

function countEditContentTotals(content: unknown): TextTotals | undefined {
	if (!Array.isArray(content) && typeof content !== "string") return undefined;
	const lines = (Array.isArray(content) ? content.map((line) => String(line)) : content.split("\n")).map(sanitizeContentLine);
	return { lines: lines.length, words: countTextWords(lines.join("\n")) };
}

function countEditTotals(args: unknown): TextTotals | undefined {
	const edits = Array.isArray((args as any)?.edits) ? ((args as any).edits as unknown[]) : undefined;
	if (!edits) return undefined;

	let lines = 0;
	let words = 0;
	let foundContent = false;

	for (const edit of edits) {
		if (!edit || typeof edit !== "object") continue;
		const totals = countEditContentTotals((edit as any).content);
		if (!totals) continue;
		foundContent = true;
		lines += totals.lines;
		words += totals.words;
	}

	return foundContent ? { lines, words } : undefined;
}

function buildDisplayDiff(
	originalLines: string[],
	nextLines: string[],
	operations: ParsedEditOperation[],
): { diff: string; firstChangedLine?: number } {
	if (operations.length === 0) return { diff: "" };
	const sorted = [...operations].sort((a, b) => a.oldStartIndex - b.oldStartIndex || a.priority - b.priority);
	const lineNumberWidth = String(Math.max(1, originalLines.length, nextLines.length)).length;
	const diffLines: string[] = [];
	let delta = 0;
	let firstChangedLine: number | undefined;
	let previousOldEndExclusive: number | undefined;

	for (const operation of sorted) {
		const oldCount = operation.oldEndIndex - operation.oldStartIndex;
		const newCount = operation.contentLines.length;
		const oldStart = operation.oldStartIndex + 1;
		const newStart = operation.oldStartIndex + 1 + delta;

		if (firstChangedLine === undefined) {
			firstChangedLine = Math.max(1, newStart);
		}
		if (previousOldEndExclusive !== undefined && operation.oldStartIndex > previousOldEndExclusive) {
			diffLines.push(` ${"".padStart(lineNumberWidth, " ")} ...`);
		}
		for (let index = 0; index < oldCount; index++) {
			const lineNumber = String(oldStart + index).padStart(lineNumberWidth, " ");
			diffLines.push(`-${lineNumber} ${originalLines[operation.oldStartIndex + index] ?? ""}`);
		}
		for (let index = 0; index < newCount; index++) {
			const lineNumber = String(newStart + index).padStart(lineNumberWidth, " ");
			diffLines.push(`+${lineNumber} ${operation.contentLines[index] ?? ""}`);
		}

		delta += newCount - oldCount;
		previousOldEndExclusive = Math.max(previousOldEndExclusive ?? 0, operation.oldEndIndex);
	}

	return { diff: diffLines.join("\n"), firstChangedLine };
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

function formatTextTotals(totals: TextTotals | undefined, theme: any): string {
	if (!totals) return "";
	return theme.fg(
		"muted",
		` ${totals.lines} line${totals.lines === 1 ? "" : "s"} ${totals.words} word${totals.words === 1 ? "" : "s"}`,
	);
}


function formatEditRow(
	status: ToolStatus,
	rawPath: string | undefined,
	theme: any,
	totals?: TextTotals,
	message?: string,
): string {
	const path = rawPath ?? "<unknown>";
	let text = `${ROW_PREFIX}${statusIcon(status, theme)} ${colorEditIcon(EDIT_ICON)} ${theme.fg("accent", path)}${formatTextTotals(
		totals,
		theme,
	)}`;
	if (message) text += ` ${theme.fg(status === "error" ? "error" : "muted", message)}`;
	return text;
}

function emptyToolRow(): Text {
	return new Text("", 0, 0);
}

function firstTextLine(result: { content: Array<{ type: string; text?: string }> }): string | undefined {
	const content = result.content[0];
	if (content?.type !== "text") return undefined;
	return content.text?.split("\n")[0];
}

export function registerEditTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "edit",
		label: "edit",
		description:
			"Edit a single file using LINE#ID anchors from the latest read output. Supported loc shapes: \"append\", \"prepend\", { append: \"LINE#ID\" }, { prepend: \"LINE#ID\" }, or { range: { pos: \"LINE#ID\", end: \"LINE#ID\" } }. If the referenced line hashes changed since the file was read, the edit is rejected before mutation.",
		promptSnippet: "Edit files using LINE#ID hash anchors from the latest read output",
		promptGuidelines: [
			"Always read a file before editing it so you have fresh LINE#ID anchors.",
			"Batch all edits for one file into a single edit call.",
			"Copy LINE#ID anchors exactly from the latest read output.",
			"Use only hashline edit blocks shaped like { loc, content }.",
			"If edit reports that anchors changed, re-read the file and retry with the updated LINE#ID values.",
		],
		parameters: editSchema,
		renderShell: "self",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const path = normalizePath((params as any).path);
			const edits = Array.isArray((params as any).edits) ? ((params as any).edits as unknown[]) : [];
			if (edits.length === 0) {
				throw new Error("edit requires at least one edit block.");
			}

			const absolutePath = resolvePath(ctx.cwd, path);

			return withFileMutationQueue(absolutePath, async () => {
				if (signal?.aborted) throw new Error("Operation aborted");

				let raw = "";
				let existed = true;
				try {
					await access(absolutePath);
					raw = await readFile(absolutePath, "utf8");
				} catch {
					existed = false;
				}

				if (signal?.aborted) throw new Error("Operation aborted");

				const { bom, text: bomStripped } = stripBom(raw);
				const originalLineEnding = detectLineEnding(bomStripped);
				const normalizedOriginal = normalizeToLF(bomStripped);
				const originalLines = existed ? textToLines(normalizedOriginal) : [];

				if (!existed) {
					for (const edit of edits) {
						const loc = (edit as any)?.loc;
						if (loc !== "append" && loc !== "prepend") {
							throw new Error(`File not found: ${path}. New files can only be created with anchorless \"append\" or \"prepend\" edits.`);
						}
					}
				}

				const operations = parseHashlineOperations(edits, originalLines);
				const nextLines = applyOperations(originalLines, operations);
				const normalizedNext = nextLines.join("\n");

				if (normalizedNext === normalizedOriginal) {
					throw new Error("The hashline edit produced no changes.");
				}

				const diff = buildDisplayDiff(originalLines, nextLines, operations);
				const finalContent = bom + restoreLineEndings(normalizedNext, originalLineEnding);
				await mkdir(dirname(absolutePath), { recursive: true });
				if (signal?.aborted) throw new Error("Operation aborted");

				const progress = await writeTextWithProgress(absolutePath, finalContent, signal, (progress) => {
					onUpdate?.({
						content: [{ type: "text" as const, text: `Writing ${path}: ${progressSummary(progress)}` }],
						details: { progress },
					});
				});
				if (signal?.aborted) throw new Error("Operation aborted");

				return {
					content: [
						{
							type: "text" as const,
							text: `Successfully applied ${operations.length} hashline edit block(s) to ${path}.`,
						},
					],
					details: { diff: diff.diff, firstChangedLine: diff.firstChangedLine, progress } as EditToolDetails & {
						progress: WriteProgress;
					},
				};
			});
		},
		renderCall(args, theme, context) {
			if (!context.isPartial) return emptyToolRow();
			const rawPath = typeof (args as any)?.path === "string" ? normalizePath((args as any).path) : undefined;
			return new Text(formatEditRow("pending", rawPath, theme, countEditTotals(args)), 0, 0);
		},
		renderResult(result, { isPartial }, theme, context) {
			const rawPath = typeof (context.args as any)?.path === "string" ? normalizePath((context.args as any).path) : undefined;
			const totals = countEditTotals(context.args);
			if (isPartial) return new Text(formatEditRow("pending", rawPath, theme, totals), 0, 0);

			if (context.isError) {
				return new Text(formatEditRow("error", rawPath, theme, totals, firstTextLine(result)), 0, 0);
			}

			return new Text(formatEditRow("done", rawPath, theme, totals), 0, 0);
		},
	});
}
