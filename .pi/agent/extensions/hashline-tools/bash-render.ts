/**
 * hashline-style bash tool rendering + a faithful local bash execute().
 *
 * Renders a model `bash` call as a compact multi-line status block:
 *
 *   ✓ $ 1.2s cd /tmp
 *         && ls -la
 *         | grep -i foo
 *         || echo done
 *         (red, 8-space-indented stderr/error when the command failed)
 *
 * Layout: [status glyph] [bash $] [duration (settled)] [first segment]
 *         (continuation segments, each offset 8 spaces, operator in front)
 *
 * - Status glyph: ✓ green (ok) · ✗ red (isError) · yellow spinner (pending).
 * - `$` is the bash execution glyph (ACTION_GLYPH.bash).
 * - The command is split at shell control operators (&& || ; | & |> and the
 *   redirections 2> > >> << < 2>&1 &> etc.) so each segment gets its own
 *   line, with the operator shown at the start of the continuation.
 * - Collapsed: the full command (all split lines), NO output. On error the
 *   error message is always shown (8-space indented, red).
 * - Expanded (app.tools.expand): the command block + full tool output below.
 * - Duration: only when settled (between the `$` and the first command line).
 *
 * renderShell: "self" is set so ToolExecutionComponent renders this into a
 * plain Container (no green/pending background, no box padding lines), reusing
 * the same single-point rendering primitives as hashline-tools' render.ts.
 */

import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
	animateSpinner,
	colorizeCommand,
	HANGING_INDENT,
	RawText,
	formatErrorDetail,
	nextSpinnerFrame,
	rememberPending,
	settlePending,
	stopSpinner,
	stripAnsi,
	wrapPath,
} from "./render";

/** 8-space offset for continuation/error lines (same as hashline). */
const CONTINUATION_INDENT = HANGING_INDENT;

/** Shell control operators: split points for the command. Longer matches first. */
const CONTROL_OPERATORS = ["||", "&&", ";;", "|&", "<<", ">>", "2>&1", ">&", "&>", "2>", ">", "<", "|", ";", "&"];

/** Pending-tick shared with hashline render (advances once per render pass). */
function advanceSpinner(): string {
	return nextSpinnerFrame();
}

/**
 * Split a shell command at control operators so each segment renders on its
 * own line with the operator visible at the start of the continuation.
 *
 * Splits: `&&` `||` `;` `|` `|&` `&` and the redirections `>` `<` `>>` `2>`
 * `2>&1` `&>` `>&`. Operators inside quotes / $() / ${} / backticks are NOT
 * split points (the command stays intact there). `#` comments keep the rest
 * of that line. Heredocs (`<<MARKER`) are consumed whole: the body up to the
 * closing delimiter is kept unmodified (no splitting on operators inside the
 * heredoc body). The marker is whatever follows `<<` in the command (e.g.
 * `EOF`, `END`, `__SQL__`, `'X'`) — the closing line must match it exactly,
 * same as bash.
 *
 * Returns an array of { op, rest } where the first entry has op === "".
 */
export function splitShellCommand(command: string): { op: string; rest: string }[] {
	const parts: { op: string; rest: string }[] = [];
	let current = "";
	let i = 0;
	let quote: "'" | '"' | "`" | null = null;
	let parenDepth = 0;
	let braceDepth = 0;

	const push = () => {
		const trimmed = current.trim();
		if (trimmed) parts.push({ op: "", rest: trimmed });
		current = "";
	};

	// Consume a heredoc body starting at `<<` (i points at the FIRST `<`).
	// Returns the new index (after the closing delimiter line) and the full
	// heredoc text (header + body + closing line) to append to `current`.
	const consumeHeredoc = (): { nextIndex: number; text: string } => {
		const start = i; // include the `<<`
		let j = i + 2; // first char after `<<`
		const dash = command[j] === "-";
		if (dash) j++;
		if (command[j] === "<") {
			// here-string `<<<` — single line, no terminator
			let end = j + 1;
			const nl = command.indexOf("\n", end);
			if (nl !== -1) end = nl;
			return { nextIndex: end, text: command.slice(start, end) };
		}
		// Skip whitespace after `<<` to find the delimiter token.
		while (j < command.length && /\s/.test(command[j])) j++;
		if (j >= command.length) {
			// no delimiter — treat as a plain `<<` redirection, single token
			return { nextIndex: j, text: command.slice(start, j) };
		}
		// Delimiter may be quoted: <<'EOF' / <<"EOF" / <<\EOF (marker is arbitrary —
		// whatever token follows `<<`, e.g. END, SQL, __MARKER__).
		let delim = "";
		let k = j;
		let q: "'" | '"' | null = null;
		if (command[k] === "'" || command[k] === '"') {
			q = command[k] as "'" | '"';
			k++;
		}
		while (k < command.length) {
			const c = command[k];
			if (q) {
				if (c === q) {
					k++;
					break;
				}
				delim += c;
			} else if (/[\s|&;<>()$`"'\n]/.test(c)) {
				break; // unquoted delimiter ends at whitespace/operator
			} else {
				delim += c;
			}
			k++;
		}
		const headerEnd = k; // end of the `<<...delim` header
		if (delim === "") {
			return { nextIndex: k, text: command.slice(start, k) };
		}
		// Find the closing line: `delim` alone (or with leading tabs if <<-).
		const lines = command.slice(headerEnd).split("\n");
		let consumedLines = 0;
		for (let li = 0; li < lines.length; li++) {
			const line = lines[li];
			const trimmed = dash ? line.replace(/^\t+/, "") : line;
			if (trimmed === delim) {
				consumedLines = li + 1; // include the closing line
				break;
			}
		}
		if (consumedLines === 0) {
			// unterminated heredoc — take the rest of the command verbatim
			return { nextIndex: command.length, text: command.slice(start) };
		}
		// Consume exactly `consumedLines` lines (each with its trailing \n) from
		// headerEnd. `lines` was split from headerEnd, so the chars consumed are
		// `consumedLines` lines joined by \n — but split() dropped the final \n
		// of each line, so add back one \n per line boundary.
		let end = headerEnd;
		for (let li = 0; li < consumedLines; li++) {
			end += lines[li].length + 1; // +1 for the \n
		}
		if (end > command.length) end = command.length;
		return { nextIndex: end, text: command.slice(start, end) };
	};	while (i < command.length) {
		const ch = command[i];
		const next = command[i + 1];

		// Heredoc: `<<` starts a body that must be kept unmodified. Must be
		// checked before the generic `<<` operator split below.
		if (ch === "<" && next === "<" && quote === null && parenDepth === 0 && braceDepth === 0) {
			const hd = consumeHeredoc();
			current += hd.text;
			i = hd.nextIndex;
			// A heredoc (including its closing delimiter) terminates the command
			// it belongs to: anything after it is a separate segment. Push now.
			push();
			continue;
		}

		if (quote === null && (ch === "'" || ch === '"' || ch === "`")) {
			quote = ch;
			current += ch;
			i++;
			continue;
		}
		if (quote === "'") {
			current += ch;
			if (ch === "'") quote = null;
			i++;
			continue;
		}
		if (quote === '"') {
			current += ch;
			if (ch === '"' && command[i - 1] !== "\\") quote = null;
			i++;
			continue;
		}
		if (quote === "`") {
			current += ch;
			if (ch === "`" && command[i - 1] !== "\\") quote = null;
			i++;
			continue;
		}
		if (quote !== null) {
			current += ch;
			i++;
			continue;
		}

		// Track nested $(...), ${...} so operators inside them aren't split.
		if (ch === "$" && next === "(") {
			parenDepth++;
			current += "$(";
			i += 2;
			continue;
		}
		if (ch === "$" && next === "{") {
			braceDepth++;
			current += "${";
			i += 2;
			continue;
		}
		if (ch === "(") {
			parenDepth++;
			current += ch;
			i++;
			continue;
		}
		if (ch === ")" && parenDepth > 0) {
			parenDepth--;
			current += ch;
			i++;
			continue;
		}
		if (ch === "}" && braceDepth > 0) {
			braceDepth--;
			current += ch;
			i++;
			continue;
		}
		if (parenDepth > 0 || braceDepth > 0) {
			current += ch;
			i++;
			continue;
		}

		// Control operator?
		let matched: string | undefined;
		for (const op of CONTROL_OPERATORS) {
			if (command.startsWith(op, i)) {
				matched = op;
				break;
			}
		}
		if (matched) {
			push();
			parts.push({ op: matched.trim(), rest: "" });
			i += matched.length;
			continue;
		}

		current += ch;
		i++;
	}
	if (current.trim()) push();

	// Merge consecutive control-only entries so `a && b` yields exactly one
	// continuation line `&& b` (not `&&` then `b`).
	const merged: { op: string; rest: string }[] = [];
	for (const part of parts) {
		const last = merged[merged.length - 1];
		if (part.op && last && last.op && !last.rest) {
			last.op += ` ${part.op}`;
			continue;
		}
		merged.push(part);
	}
	return merged;
}

/**
 * Build the first (status) line of the bash block.
 *
 *   ✓ $ 1.2s first-segment
 *
 * Only the FIRST split segment goes here; continuation segments (after &&, ||,
 * | etc.) are rendered by formatCommandContinuations() below.
 */
export function formatBashStatusLine(
	theme: Theme,
	command: string,
	status: "pending" | "ok" | "error",
	elapsedMs?: number,
	maxWidth = 120,
): string {
	const statusGlyph =
		status === "pending"
			? theme.fg("warning", advanceSpinner())
			: status === "error"
				? theme.fg("error", "✗")
				: theme.fg("success", "✓");
	const bashGlyph = theme.fg("accent", "$");
	const elapsed = elapsedMs !== undefined ? theme.fg("dim", `${(elapsedMs / 1000).toFixed(1)}s`) : "";

	const parts = splitShellCommand(command);
	const first = parts[0]?.rest ?? "";

	const prefixParts = [statusGlyph, bashGlyph];
	if (elapsed) prefixParts.push(elapsed);
	const prefix = `${prefixParts.join(" ")} `;
	const prefixWidth = stripAnsi(prefix).length;
	const width = Math.max(24, maxWidth - prefixWidth);

	// If the first segment contains a heredoc (`<<`), render it verbatim: the
	// heredoc body must stay unmodified (never re-wrapped or re-indented). Only
	// the part before the `<<` gets width-wrapped. Colorize AFTER wrapping so
	// wrapPath sees plain text.
	const heredocIdx = first.indexOf("<<");
	if (heredocIdx !== -1) {
		const head = first.slice(0, heredocIdx);
		const heredoc = first.slice(heredocIdx);
		return prefix + colorizeCommand(wrapPath(head, width) + heredoc);
	}
	return prefix + colorizeCommand(wrapPath(first, width));
}

/**
 * Build the continuation lines: each split segment after the first, offset 8
 * spaces with its operator glyph (dim) in front.
 *
 *   && grep foo
 *   || echo done
 *   | head
 */
export function formatCommandContinuations(theme: Theme, command: string): string {
	const parts = splitShellCommand(command);
	if (parts.length <= 1) return "";
	const lines: string[] = [];
	// parts[0] is the first segment (shown on the status header line).
	for (let idx = 1; idx < parts.length; idx++) {
		const part = parts[idx];
		if (part.op && !part.rest) {
			// Operator entry; find the following rest entry (may be empty at end).
			let rest = "";
			let j = idx + 1;
			while (j < parts.length) {
				if (parts[j].rest) {
					rest = parts[j].rest;
					break;
				}
				if (parts[j].op) break; // another operator without rest — stop
				j++;
			}
			const op = theme.fg("dim", part.op);
			const sep = rest ? " " : "";
			lines.push(`${CONTINUATION_INDENT}${op}${sep}${rest ? colorizeCommand(rest) : ""}`);
			if (rest) idx = j; // consume the paired rest entry
		} else if (part.rest && !part.op) {
			lines.push(`${CONTINUATION_INDENT}${colorizeCommand(part.rest)}`);
		}
	}
	return lines.join("\n");
}

/**
 * Build the pending (spinner) component. Returns a RawText that shows the
 * full command (status line + continuation lines) while the tool is running,
 * remembered by toolCallId so renderResult can settle the status line in place.
 */
export function pendingBashComponent(theme: Theme, command: string, toolCallId?: string): Component {
	const statusLine = formatBashStatusLine(theme, command, "pending", undefined, 120);
	const continuations = formatCommandContinuations(theme, command);
	const text = continuations ? `${statusLine}\n${continuations}` : statusLine;
	const line = new RawText(text);
	rememberPending(toolCallId, line);
	return line;
}

/**
 * Build the settled result. Settles the pending line in place and returns the
 * body (command block + optional expanded output, or error detail).
 */
export function settledBashComponent(
	theme: Theme,
	result: AgentToolResult<unknown> & { isError?: boolean },
	command: string,
	expanded: boolean,
	elapsedMs: number | undefined,
	toolCallId?: string,
	output: string = "",
	partial = false,
	invalidate?: () => void,
): Component {
	if (partial) {
		// Still pending: keep the spinner animating, don't settle the header.
		// The TUI re-adds both components each pass; returning nothing keeps the
		// pending spinner visible without settling the header early.
		animateSpinner(toolCallId, invalidate ?? (() => {}));
		return new RawText("");
	}
	stopSpinner(toolCallId);
	const isError = result.isError ?? false;
	const status = isError ? "error" : "ok";
	// Settle the pending (renderCall) line in place with the final status header
	// (✓/✗ $ + elapsed). That line is the header; the body we return here must
	// NOT repeat it (the TUI renders both components stacked).
	const header = formatBashStatusLine(theme, command, status, elapsedMs, 120);
	settlePending(toolCallId, header);

	if (isError) {
		// The header already lives in the in-place pending line; return only the
		// red, 8-space-indented error detail so it renders once below it.
		const detail = getErrorDetail(result, command);
		return new RawText(detail ? formatErrorDetail(theme, detail) : "");
	}

	// Body = continuation lines (first segment lives on the settled header)
	// + optional expanded output. No header, no duplicate first line.
	const outputText = extractOutput(result).trim();
	const continuations = formatCommandContinuations(theme, command);
	const bodyLines: string[] = [];
	if (continuations) bodyLines.push(continuations);
	if (expanded && outputText) {
		if (bodyLines.length > 0) bodyLines.push("");
		bodyLines.push(outputText);
	}
	const truncation = result.details?.truncation as
		| { truncated?: boolean; outputLines?: number; totalLines?: number; truncatedBy?: string; maxBytes?: number }
		| undefined;
	const fullOutputPath = result.details?.fullOutputPath as string | undefined;
	if (truncation?.truncated || fullOutputPath) {
		const warnings: string[] = [];
		if (fullOutputPath) warnings.push(`Full output: ${fullOutputPath}`);
		if (truncation?.truncated) {
			if (truncation.truncatedBy === "lines") {
				warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
			} else {
				warnings.push(`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`);
			}
		}
		bodyLines.push(theme.fg("warning", `[${warnings.join(". ")}]`));
	}
	return new RawText(bodyLines.join("\n"));
}

/** Pull the human-facing error message out of an errored bash result. */
function getErrorDetail(result: AgentToolResult<unknown> & { isError?: boolean }, command: string): string {
	if (result.isError && result.content) {
		const text = result.content
			.map((c) => (c.type === "text" ? c.text : ""))
			.filter(Boolean)
			.join("\n")
			.trim();
		if (text) return text;
	}
	// Fall back to a generic message pointing at the failed command.
	return `Command failed (exit code non-zero): ${command.trim()}`;
}

/** Extract plain text from the tool result content (drops image blocks). */
function extractOutput(result: AgentToolResult<unknown> & { isError?: boolean }): string {
	if (!result?.content) return "";
	return result.content
		.filter((c) => c.type === "text")
		.map((c) => (c.type === "text" ? c.text : ""))
		.join("\n");
}

/**
 * Faithful local bash execute() — spawns via pi's exported local operations,
 * accumulates streaming output with a bounded tail + temp-file spill, enforces
 * the same truncation/timeout/exit-code rules as the built-in bash tool, and
 * emits throttled partial updates through onUpdate so the TUI can stream.
 *
 * This exists because extensions override the built-in bash by name, so the
 * custom tool must supply its own execute (the built-in one isn't injectable).
 */
export async function executeBash(
	_toolCallId: string,
	params: { command: string; timeout?: number },
	signal: AbortSignal | undefined,
	onUpdate: ((update: any) => void) | undefined,
	ctx: { cwd: string },
): Promise<AgentToolResult<{ truncation?: unknown; fullOutputPath?: string } | undefined>> {
	const { command, timeout } = params;
	const ops = createLocalBashOperations();
	const output = new BoundedOutputAccumulator();
	let acceptingOutput = true;
	let updateTimer: NodeJS.Timeout | undefined;
	let updateDirty = false;
	let lastUpdateAt = 0;
	const BASH_UPDATE_THROTTLE_MS = 100;

	const emitOutputUpdate = () => {
		if (!onUpdate || !updateDirty) return;
		updateDirty = false;
		lastUpdateAt = Date.now();
		const snapshot = output.snapshot({ persistIfTruncated: true });
		onUpdate({ content: [{ type: "text", text: snapshot.content || "" }], details: { truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined, fullOutputPath: snapshot.fullOutputPath } });
	};
	const scheduleOutputUpdate = () => {
		if (!onUpdate) return;
		updateDirty = true;
		const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
		if (delay <= 0) {
			if (updateTimer) clearTimeout(updateTimer);
			emitOutputUpdate();
			return;
		}
		if (!updateTimer) {
			updateTimer = setTimeout(() => {
				updateTimer = undefined;
				emitOutputUpdate();
			}, delay);
		}
	};
	const clearUpdateTimer = () => {
		if (updateTimer) {
			clearTimeout(updateTimer);
			updateTimer = undefined;
		}
	};

	try {
		if (onUpdate) onUpdate({ content: [], details: undefined });

		const handleData = (data: Buffer) => {
			if (!acceptingOutput) return;
			output.append(data);
			scheduleOutputUpdate();
		};
		const finishOutput = async () => {
			acceptingOutput = false;
			output.finish();
			clearUpdateTimer();
			emitOutputUpdate();
			const snapshot = output.snapshot({ persistIfTruncated: true });
			await output.closeTempFile();
			return snapshot;
		};
		const formatOutput = (snapshot: ReturnType<BoundedOutputAccumulator["snapshot"]>, emptyText = "(no output)") => {
			const truncation = snapshot.truncation;
			let text = snapshot.content || emptyText;
			let details: { truncation?: unknown; fullOutputPath?: string } | undefined;
			if (truncation.truncated) {
				details = { truncation, fullOutputPath: snapshot.fullOutputPath };
				const startLine = truncation.totalLines - truncation.outputLines + 1;
				const endLine = truncation.totalLines;
				if (truncation.lastLinePartial) {
					text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${formatSize(output.getLastLineBytes())}). Full output: ${snapshot.fullOutputPath}]`;
				} else if (truncation.truncatedBy === "lines") {
					text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
				} else {
					text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
				}
			}
			return { text, details };
		};
		const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;

		let exitCode: number | null;
		try {
			const result = await ops.exec(command, ctx.cwd, {
				onData: handleData,
				signal,
				timeout,
			});
			exitCode = result.exitCode;
		} catch (err) {
			const snapshot = await finishOutput();
			const { text } = formatOutput(snapshot, "");
			if (err instanceof Error && err.message === "aborted") {
				throw new Error(appendStatus(text, "Command aborted"));
			}
			if (err instanceof Error && err.message.startsWith("timeout:")) {
				const timeoutSecs = err.message.split(":")[1];
				throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
			}
			throw err;
		}
		const snapshot = await finishOutput();
		const { text: outputText, details } = formatOutput(snapshot);
		if (exitCode !== 0 && exitCode !== null) {
			throw new Error(appendStatus(outputText, `Command exited with code ${exitCode}`));
		}
		return { content: [{ type: "text", text: outputText }], details };
	} finally {
		clearUpdateTimer();
	}
}

/**
 * Minimal streaming output accumulator with bounded memory + temp-file spill.
 * Mirrors pi's internal OutputAccumulator (not exported) with the same
 * truncation semantics (DEFAULT_MAX_LINES / DEFAULT_MAX_BYTES, tail snapshot).
 */
export class BoundedOutputAccumulator {
	maxLines = DEFAULT_MAX_LINES;
	maxBytes = DEFAULT_MAX_BYTES;
	maxRollingBytes = Math.max(this.maxBytes * 2, 1);
	tempFilePrefix = "pi-bash";
	decoder = new TextDecoder();
	rawChunks: Buffer[] = [];
	tailText = "";
	tailBytes = 0;
	tailStartsAtLineBoundary = true;
	totalRawBytes = 0;
	totalDecodedBytes = 0;
	totalLines = 1;
	currentLineBytes = 0;
	finished = false;
	tempFilePath: string | undefined;
	tempFileStream: ReturnType<typeof createWriteStream> | undefined;

	append(data: Buffer) {
		if (this.finished) throw new Error("Cannot append to a finished output accumulator");
		this.totalRawBytes += data.length;
		this.appendDecodedText(this.decoder.decode(data, { stream: true }));
		if (this.tempFileStream || this.shouldUseTempFile()) {
			this.ensureTempFile();
			this.tempFileStream?.write(data);
		} else if (data.length > 0) {
			this.rawChunks.push(data);
		}
	}
	finish() {
		if (this.finished) return;
		this.finished = true;
		this.appendDecodedText(this.decoder.decode());
		if (this.shouldUseTempFile()) this.ensureTempFile();
	}
	snapshot(options: { persistIfTruncated?: boolean } = {}) {
		const tailTruncation = truncateTail(this.getSnapshotText(), { maxLines: this.maxLines, maxBytes: this.maxBytes });
		const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
		const truncatedBy = truncated
			? (tailTruncation.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))
			: null;
		const truncation = {
			...tailTruncation,
			truncated,
			truncatedBy,
			totalLines: this.totalLines,
			totalBytes: this.totalDecodedBytes,
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		};
		if (options.persistIfTruncated && truncation.truncated) this.ensureTempFile();
		return { content: truncation.content, truncation, fullOutputPath: this.tempFilePath };
	}
	async closeTempFile() {
		if (!this.tempFileStream) return;
		const stream = this.tempFileStream;
		this.tempFileStream = undefined;
		await new Promise<void>((resolve, reject) => {
			const onError = (err: Error) => {
				stream.off("finish", onFinish);
				reject(err);
			};
			const onFinish = () => {
				stream.off("error", onError);
				resolve();
			};
			stream.once("error", onError);
			stream.once("finish", onFinish);
			stream.end();
		});
	}
	getLastLineBytes() {
		return this.currentLineBytes;
	}
	private appendDecodedText(text: string) {
		if (text.length === 0) return;
		const bytes = Buffer.byteLength(text, "utf-8");
		this.totalDecodedBytes += bytes;
		this.tailText += text;
		this.tailBytes += bytes;
		if (this.tailBytes > this.maxRollingBytes * 2) this.trimTail();
		let newlines = 0;
		let lastNewline = -1;
		for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
			newlines++;
			lastNewline = i;
		}
		if (newlines === 0) {
			this.currentLineBytes += bytes;
		} else {
			this.totalLines += newlines;
			this.currentLineBytes = Buffer.byteLength(text.slice(lastNewline + 1), "utf-8");
		}
	}
	private trimTail() {
		const buffer = Buffer.from(this.tailText, "utf-8");
		if (buffer.length <= this.maxRollingBytes) {
			this.tailBytes = buffer.length;
			return;
		}
		let start = buffer.length - this.maxRollingBytes;
		while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
		this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
		this.tailText = buffer.subarray(start).toString("utf-8");
		this.tailBytes = Buffer.byteLength(this.tailText, "utf-8");
	}
	private getSnapshotText() {
		if (this.tailStartsAtLineBoundary) return this.tailText;
		const firstNewline = this.tailText.indexOf("\n");
		return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
	}
	private shouldUseTempFile() {
		return this.totalRawBytes > this.maxBytes || this.totalDecodedBytes > this.maxBytes || this.totalLines > this.maxLines;
	}
	private ensureTempFile() {
		if (this.tempFilePath) return;
		const id = randomBytes(8).toString("hex");
		this.tempFilePath = join(tmpdir(), `${this.tempFilePrefix}-${id}.log`);
		this.tempFileStream = createWriteStream(this.tempFilePath);
		for (const chunk of this.rawChunks) this.tempFileStream.write(chunk);
		this.rawChunks = [];
	}
}
