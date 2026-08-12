/**
 * Single-line tool status headers for read/write/edit.
 *
 * Layout (one logical line; long paths wrap with an 8-space hanging indent):
 *
 *   ✓ ⬇ 1-1000 a1b2 src/foo.ts
 *   ✗ ✎ 12-14 9f3c src/bar.ts
 *   ⠋ ⬇ …     …    src/baz.ts        (pending — spinner)
 *
 * Fields: [status glyph] [action glyph] [range] [file hash] [path]
 *
 * - Status glyph: ✓ green (settled ok) · ✗ red (isError) · yellow spinner (pending).
 * - Action glyph: read ↑ · write ⇊ · edit ↓.
 * - The [path#TAG] header from the model payload is what carries the tag; the
 *   TUI header re-renders it as `tag path` so nothing is lost in display.
 *
 * renderShell: "self" is set on the tools so ToolExecutionComponent renders this
 * into a plain Container — no green/pending background, no box padding lines.
 */

import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Continuation-line indent for wrapped paths (8 spaces). */
const HANGING_INDENT = "        ";

/** Module-level spinner tick: advances once per render invocation while pending. */
let spinnerTick = 0;

/**
 * Live pending-status lines keyed by toolCallId.
 *
 * ToolExecutionComponent always re-renders BOTH renderCall (pending line) and
 * renderResult (settled line) into the same container — so a settled line that
 * returns its own header would stack a duplicate below the pending one. Instead
 * renderResult looks up the pending line by toolCallId and rewrites it in place
 * (setText), then returns only the body (empty when collapsed). One line, no
 * duplicates.
 */
const pendingLines = new Map<string, RawText>();

function rememberPending(toolCallId: string | undefined, line: RawText): void {
	if (!toolCallId) return;
	pendingLines.set(toolCallId, line);
	// Bounded: forget the oldest if we somehow accumulate strays (aborted calls).
	if (pendingLines.size > 256) {
		const eldest = pendingLines.keys().next().value;
		if (eldest !== undefined) pendingLines.delete(eldest);
	}
}

function settlePending(toolCallId: string | undefined, text: string): void {
	if (!toolCallId) return;
	const line = pendingLines.get(toolCallId);
	if (line) {
		line.setText(text);
		pendingLines.delete(toolCallId);
	}
}

export const ACTION_GLYPH = {
	read: "↑",
	write: "⇊",
	edit: "↓",
} as const;

export type ActionKind = keyof typeof ACTION_GLYPH;

const HEADER_RE = /^\[([^\]\#\r\n]+)#([0-9A-Fa-f]{4})\]/;

/** Pull `{ path, tag }` out of the model-visible `[path#TAG]` header line, if present. */
export function parseHeaderLine(text: string): { path: string; tag?: string } {
	const line = text.split("\n", 1)[0] ?? "";
	const m = line.match(HEADER_RE);
	if (!m) return { path: "" };
	return { path: m[1], tag: m[2].toUpperCase() };
}

function stripAnsi(s: string): string {
	let out = "";
	let i = 0;
	while (i < s.length) {
		if (s[i] === "\x1b") {
			if (s[i + 1] === "[" || s[i + 1] === "]") {
				const esc = s[i + 1];
				let j = i + 2;
				if (esc === "[") {
					while (j < s.length && !/[mGKHJ]/.test(s[j])) j++;
					if (j < s.length) {
						i = j + 1;
						continue;
					}
				} else {
					while (j < s.length && s[j] !== "\x07") {
						if (s[j] === "\x1b" && s[j + 1] === "\\") {
							j += 2;
							break;
						}
						j++;
					}
					i = j;
					continue;
				}
			}
		}
		out += s[i++];
	}
	return out;
}

/**
 * Build the one-line status header.
 *
 * @param theme       active pi theme (fg/bold/dim).
 * @param kind        read | write | edit.
 * @param range       e.g. "1-1000", "12-14", or "" when unknown.
 * @param tag         file hash (4-hex) or "".
 * @param path        full file name; wrapped to `maxWidth` with 8-space hanging indent.
 * @param status      "pending" | "ok" | "error".
 */
export function formatStatusLine(
	theme: Theme,
	kind: ActionKind,
	range: string,
	tag: string,
	path: string,
	status: "pending" | "ok" | "error",
	maxWidth: number,
): string {
	const action = theme.fg(kind === "read" ? "accent" : kind === "write" ? "accent" : "accent", ACTION_GLYPH[kind]);

	const statusGlyph =
		status === "pending"
			? theme.fg("warning", SPINNER_FRAMES[spinnerTick % SPINNER_FRAMES.length])
			: status === "error"
				? theme.fg("error", "✗")
				: theme.fg("success", "✓");

	const prefixParts: string[] = [statusGlyph, action];
	// Range may be pre-styled (edit: green +added / red -removed); wrap in dim only when plain.
	if (range) prefixParts.push(/\x1b\[/.test(range) ? range : theme.fg("dim", range));
	if (tag) prefixParts.push(theme.fg("muted", tag));

	// Strip ANSI to measure visible width of the prefix (status + action + range + tag).
	const prefix = `${prefixParts.join(" ")} `;
	const prefixWidth = visibleWidth(stripAnsi(prefix));
	const pathWidth = Math.max(24, maxWidth - prefixWidth);

	const wrapped = wrapPath(path, pathWidth);

	return prefix + wrapped;
}

/** Wrap a (possibly styled) path at `width`, hanging subsequent lines 8 spaces. */
function wrapPath(path: string, width: number): string {
	if (width <= 0) return path;
	// Paths are typically unstyled here (we style at the end), but keep it safe.
	const plain = stripAnsi(path);
	if (visibleWidth(plain) <= width) return path;

	const lines: string[] = [];
	let current = "";
	let currentWidth = 0;
	for (const ch of plain) {
		const w = visibleWidth(ch);
		if (currentWidth + w > width) {
			lines.push(current);
			current = HANGING_INDENT;
			currentWidth = visibleWidth(HANGING_INDENT);
		}
		current += ch;
		currentWidth += w;
	}
	if (current) lines.push(current);
	return lines.join("\n");
}

/** The component used in renderCall (pending) — returns a spinner that animates. */
export function pendingComponent(
	theme: Theme,
	kind: ActionKind,
	path: string,
	toolCallId?: string,
): Component {
	spinnerTick++;
	const line = new RawText(formatStatusLine(theme, kind, "…", "", path, "pending", 120));
	// Remember so renderResult can rewrite this same line in place.
	rememberPending(toolCallId, line);
	return line;
}

/**
 * Settle the pending line in place and return the body content (or nothing).
 *
 * Returns an empty component when there's no body (collapsed read / plain
 * status) so ToolExecutionComponent appends nothing — the single header line
 * already shows the settled ✓/✗ state. On error, an 8-space-indented error
 * message is always shown (even collapsed) so a failed call says WHY.
 */
export function settledComponent(
	theme: Theme,
	kind: ActionKind,
	range: string,
	tag: string,
	path: string,
	status: "ok" | "error",
	maxWidth: number,
	body?: string,
	toolCallId?: string,
	errorDetail?: string,
): Component {
	const header = formatStatusLine(theme, kind, range, tag, path, status, maxWidth);
	settlePending(toolCallId, header);
	if (status === "error" && errorDetail) {
		// The header already lives in the in-place pending line; return only the
		// indented red detail so it renders once below it.
		return new RawText(formatErrorDetail(theme, errorDetail));
	}
	return new RawText(body ?? "");
}

/**
 * Wrap an error message as red 8-space-indented detail line(s) shown under the
 * status header on failure. Multi-line messages keep the indent and red color
 * on every line.
 */
export function formatErrorDetail(theme: Theme, message: string): string {
	const red = theme.fg("error", message);
	return red
		.split("\n")
		.map((line) => `${HANGING_INDENT}${line}`)
		.join("\n");
}

/**
 * Minimal component: returns the exact text lines with NO trailing padding and
 * no left margin. pi's Text pads each line to full width (trailing spaces) and
 * adds margins; for a clean single-line status we want byte-exact lines.
 */
export class RawText implements Component {
	#text: string;
	constructor(text: string) {
		this.#text = text;
	}
	setText(text: string) {
		this.#text = text;
	}
	invalidate() {}
	render(_width: number): string[] {
		return this.#text === "" ? [] : this.#text.split("\n");
	}
}
