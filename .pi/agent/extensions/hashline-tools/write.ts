/**
 * write override: hashline-aware file creation/overwrite.
 *
 * - Unwraps `[path#TAG]` write targets (model copies the read header as a path).
 * - Strict echo-stripping: content that is verbatim read output (every line
 *   `N:`-prefixed) is cleaned before it hits disk, with a note — never silently.
 * - Drift guard: overwriting a file whose on-disk content no longer matches the
 *   store's head version (out-of-band change) is DENIED with a re-read note.
 *   Overwriting a file we have no snapshot of is allowed with a warning note.
 * - Post-write: the fresh content is snapshotted and the result carries the new
 *   `[path#TAG]` header, so follow-up edits validate with zero re-reads.
 *   seenLines stays undefined (the model authored every line → skip seen check).
 *
 * Note: no withFileMutationQueue here — the built-in write already participates
 * in the per-file queue internally, and wrapping a delegate call in the same
 * queue self-deadlocks (non-reentrant). The drift check runs just before the
 * delegate's queued write, which is the acceptable TOCTOU window.
 */

import { createWriteTool } from "@earendil-works/pi-coding-agent";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { computeFileHash, displayPath, formatHeader, stripEchoedPrefixes, unwrapHeaderPath } from "./format";
import { snapshots } from "./store";

const MAX_GUARD_BYTES = 8 * 1024 * 1024;

interface WriteParams {
	path: string;
	content: string;
}

export async function executeWrite(
	toolCallId: string,
	params: WriteParams,
	signal: AbortSignal | undefined,
	onUpdate: unknown,
	ctx: { cwd: string },
) {
	const unwrapped = unwrapHeaderPath(params.path.replace(/^@/, ""));
	const absolutePath = resolve(ctx.cwd, unwrapped.path);
	const shown = displayPath(absolutePath, ctx.cwd);

	const notes: string[] = [];

	// Drift guard.
	let exists = false;
	let size = 0;
	try {
		const st = await stat(absolutePath);
		exists = st.isFile();
		size = st.size;
	} catch {
		/* does not exist */
	}
	if (exists) {
		const head = snapshots.head(absolutePath);
		if (head && size <= MAX_GUARD_BYTES) {
			const live = await readFile(absolutePath, "utf8");
			if (computeFileHash(live) !== head.tag) {
				throw new Error(
					`Write refused: ${shown} changed on disk since the last read (tag #${head.tag} no longer matches). ` +
						`Read it again to see the current content, then rewrite.`,
				);
			}
		} else if (!head) {
			notes.push(`Note: overwrote existing file that was never read this session.`);
		}
	}

	const stripped = stripEchoedPrefixes(params.content);
	if (stripped.stripped) {
		notes.push(`Note: auto-stripped hashline display prefixes (N:) from content before writing.`);
	}

	const delegate = createWriteTool(ctx.cwd);
	const result = await delegate.execute(
		toolCallId,
		{ path: unwrapped.path, content: stripped.text },
		signal,
		onUpdate as never,
	);

	// Post-commit snapshot: follow-up edits validate without a re-read.
	let header: string | undefined;
	if (Buffer.byteLength(stripped.text, "utf8") <= MAX_GUARD_BYTES) {
		const tag = snapshots.record(absolutePath, stripped.text);
		header = formatHeader(shown, tag);
	}

	const first = result.content.find((c): c is { type: "text"; text: string } => c.type === "text");
	if (first) {
		let text = first.text;
		if (header) text = `${header}\n${text}`;
		if (notes.length > 0) text = `${text}\n${notes.join("\n")}`;
		first.text = text;
	}
	return result;
}
