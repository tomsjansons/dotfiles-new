/**
 * read override: OMP-style hashline output.
 *
 *   [src/foo.ts#1A2B]
 *   12:const x = 1;
 *
 * - Whole-file snapshot recorded per read; seenLines tracks displayed lines.
 * - Self-expiring dedup: an identical repeat window of unchanged content
 *   returns a one-line stub ONCE, then content again (cheap miss, no stale loop).
 * - Notes, not errors: empty file / past-EOF / truncation all return neutral
 *   bracketed notes with precomputed resume offsets (no red tool failures).
 * - Images and oversized/binary files delegate to the built-in read unchanged.
 * - Device files that can never EOF are refused before any I/O.
 */

import { createReadTool } from "@earendil-works/pi-coding-agent";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { computeFileHash, displayPath, formatHeader } from "./format";
import { snapshots } from "./store";

const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;
const MAX_LINE_CHARS = 2000; // per-line clamp: catches the minified one-line bundle
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024; // don't snapshot (or hashline) huge files
const MAX_TEXT_BYTES = 32 * 1024 * 1024; // beyond this, delegate wholesale to built-in read

/** Files that must never be opened: no extension to sniff, and a read that never EOFs is a self-shipped DoS. */
const BLOCKED_DEVICE_RE = /^\/(dev\/(zero|null|full|random|urandom|stdin|stdout|stderr)|proc\/[^/]+\/fd\/)/;

const IMAGE_MAGIC: number[][] = [
	[0x89, 0x50, 0x4e, 0x47], // PNG
	[0xff, 0xd8, 0xff], // JPEG
	[0x47, 0x49, 0x46, 0x38], // GIF8
	[0x42, 0x4d], // BMP
	[0x52, 0x49, 0x46, 0x46], // RIFF (webp; good enough to delegate)
];

function hasMagic(buf: Buffer, magic: number[]): boolean {
	return magic.every((b, i) => buf.length > i && buf[i] === b);
}

/** Self-expiring dedup markers: path → `${tag}:${first}-${last}` of the last read window served. */
const lastWindow = new Map<string, string>();

interface ReadParams {
	path: string;
	filePath?: string;
	offset?: number;
	limit?: number;
}

/** Notes are facts about the world, not errors: never isError, carry empty details. */
function note(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}

export async function executeRead(
	toolCallId: string,
	params: ReadParams,
	signal: AbortSignal | undefined,
	onUpdate: unknown,
	ctx: { cwd: string },
) {
	const rawPath = (params.path ?? params.filePath ?? "").replace(/^@/, "");
	const absolutePath = resolve(ctx.cwd, rawPath);
	const delegate = createReadTool(ctx.cwd);

	if (BLOCKED_DEVICE_RE.test(absolutePath)) {
		return note(`[Refused: ${absolutePath} is a device/special file that may never terminate a read]`);
	}

	// Repair numeric-string offsets ("2000" → 2000); reject fractional windows outright.
	const offset = params.offset === undefined ? undefined : Number(params.offset);
	const limit = params.limit === undefined ? undefined : Number(params.limit);
	if (offset !== undefined && (!Number.isInteger(offset) || offset < 1)) {
		return note(`[Invalid offset ${JSON.stringify(params.offset)}: expected a positive integer line number]`);
	}
	if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
		return note(`[Invalid limit ${JSON.stringify(params.limit)}: expected a positive integer]`);
	}

	let st;
	try {
		st = await stat(absolutePath);
	} catch {
		// Not-found handling stays with the built-in (its error text is what models expect).
		return delegate.execute(toolCallId, { path: rawPath, offset, limit } as never, signal, onUpdate as never);
	}
	if (!st.isFile() || st.size > MAX_TEXT_BYTES) {
		return delegate.execute(toolCallId, { path: rawPath, offset, limit } as never, signal, onUpdate as never);
	}

	const buf = await readFile(absolutePath);
	if (IMAGE_MAGIC.some((m) => hasMagic(buf, m))) {
		return delegate.execute(toolCallId, { path: rawPath, offset, limit } as never, signal, onUpdate as never);
	}
	if (buf.subarray(0, 8192).includes(0)) {
		return note(`[Binary file: ${displayPath(absolutePath, ctx.cwd)} (${st.size} bytes). Not displayed]`);
	}

	let text = buf.toString("utf8");
	if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
	const shown = displayPath(absolutePath, ctx.cwd);
	const allLines = text.split("\n");
	const totalLines = allLines.length;

	if (text.length === 0) {
		const tag = snapshots.record(absolutePath, text, []);
		return note(`${formatHeader(shown, tag)}\n[${shown} is empty (0 lines)]`);
	}

	const startLine = offset ? offset - 1 : 0;
	if (startLine >= totalLines) {
		return note(
			`[Line ${offset} is beyond end of ${shown} (${totalLines} lines total). Use offset=${totalLines} to read the last line]`,
		);
	}

	// Window selection with three ceilings: line window, byte budget, per-line clamp.
	const requestedEnd = limit !== undefined ? Math.min(startLine + limit, totalLines) : totalLines;
	const outLines: string[] = [];
	let bytes = 0;
	let end = startLine;
	let truncatedBy: "lines" | "bytes" | undefined;
	let clampedCount = 0;
	for (; end < requestedEnd; end++) {
		if (outLines.length >= MAX_LINES) {
			truncatedBy = "lines";
			break;
		}
		let line = allLines[end];
		const lineBytes = Buffer.byteLength(line, "utf8");
		if (bytes + lineBytes > MAX_BYTES) {
			truncatedBy = "bytes";
			break;
		}
		if (line.length > MAX_LINE_CHARS) {
			// Show a true prefix of the real line (anchors stay valid); the clamp
			// notice goes on its own line, never inside the content.
			line = line.slice(0, MAX_LINE_CHARS);
			clampedCount++;
		}
		bytes += lineBytes + 1;
		outLines.push(line);
	}
	const lastShown = startLine + outLines.length; // exclusive
	const firstDisplay = startLine + 1;
	const lastDisplay = lastShown; // 1-indexed inclusive == exclusive bound

	// Snapshot + seen-line provenance (bounded files only).
	let header: string | undefined;
	if (buf.length <= MAX_SNAPSHOT_BYTES) {
		const seen: number[] = [];
		for (let n = firstDisplay; n <= lastDisplay; n++) seen.push(n);
		const tag = snapshots.record(absolutePath, text, seen);
		header = formatHeader(shown, tag);

		// Self-expiring dedup: identical window of unchanged content → stub once.
		const windowKey = `${tag}:${firstDisplay}-${lastDisplay}:${limit ?? "all"}`;
		if (lastWindow.get(absolutePath) === windowKey) {
			lastWindow.delete(absolutePath); // consume: next identical read returns content again
			return note(`[${shown}#${tag}] unchanged since last read (lines ${firstDisplay}-${lastDisplay} already in context)`);
		}
		lastWindow.set(absolutePath, windowKey);
	}

	const body = outLines.map((l, i) => `${firstDisplay + i}:${l}`).join("\n");
	const parts: string[] = [];
	if (header) parts.push(header);
	parts.push(body);
	if (clampedCount > 0) parts.push(`[${clampedCount} line(s) clamped to ${MAX_LINE_CHARS} chars]`);
	if (truncatedBy) {
		const nextOffset = lastShown + 1;
		parts.push(
			`[Showing lines ${firstDisplay}-${lastDisplay} of ${totalLines}${truncatedBy === "bytes" ? " (byte limit)" : ""}. Use offset=${nextOffset} to continue.]`,
		);
	}
	return note(parts.join("\n"));
}
