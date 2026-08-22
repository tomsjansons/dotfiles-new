/**
 * write override: hashline-aware file creation/overwrite.
 *
 * - Unwraps `[path#TAG]` and bare `path#TAG` write targets (shared parser).
 *   Tag-like paths that don't parse are REFUSED with format guidance — never
 *   written as literal '#' filenames (the stray `SKILL.md#BFE8` incident).
 * - A passed tag is validated fail-closed: unknown tag, or on-disk drift vs
 *   the tagged version, is denied with a re-read note. (Previously the tag
 *   was stripped and ignored — a wrong-hex tag wrote silently.)
 * - Strict echo-stripping: content that is verbatim read output (every line
 *   `N:`-prefixed) is cleaned before it hits disk, with a note — never silently.
 * - Untagged drift guard: overwriting a file whose on-disk content no longer
 *   matches the store's head version (out-of-band change) is DENIED with a
 *   re-read note. Overwriting a file we have no snapshot of is allowed with
 *   a warning note.
 * - Post-write: the fresh content is snapshotted and the result carries the new
 *   `[path#TAG]` header, so follow-up edits validate with zero re-reads.
 *   seenLines stays undefined (the model authored every line → skip seen check).
 * - Tag-on-tag ([foo#AB12#CDEF]) and tagged-create responses carry an
 *   explanatory note — that anomaly used to pass silently.
 *
 * Note: no withFileMutationQueue here — the built-in write already participates
 * in the per-file queue internally, and wrapping a delegate call in the same
 * queue self-deadlocks (non-reentrant). The drift check runs just before the
 * delegate's queued write, which is the acceptable TOCTOU window.
 */

import { createWriteTool } from "@earendil-works/pi-coding-agent";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { computeFileHash, displayPath, formatHeader, stripEchoedPrefixes, tagOnTagNote, unwrapHeaderPath } from "./format";
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
	if (unwrapped.malformed || !unwrapped.path) {
		throw new Error(
			`Write refused: ${JSON.stringify(params.path)} ${unwrapped.malformed ?? "could not be parsed"}. ` +
				`Pass the plain path, or copy the [path#TAG] header from read output verbatim. ` +
				`If you really mean a filename containing '#', write it via bash.`,
		);
	}
	const targetPath: string = unwrapped.path;
	const absolutePath = resolve(ctx.cwd, targetPath);
	const shown = displayPath(absolutePath, ctx.cwd);

	const notes: string[] = [];

	let exists = false;
	let size = 0;
	try {
		const st = await stat(absolutePath);
		exists = st.isFile();
		size = st.size;
	} catch {
		/* does not exist */
	}
	if (exists && unwrapped.tag) {
		// A passed tag names the exact version being overwritten: fail closed.
		const snap = snapshots.byHash(absolutePath, unwrapped.tag);
		if (!snap) {
			throw new Error(
				`Write refused: tag #${unwrapped.tag} for ${shown} is not tracked (file changed or snapshot expired). ` +
					`Read the file again to get a fresh tag, then rewrite using the plain path.`,
			);
		}
		if (size <= MAX_GUARD_BYTES) {
			const live = await readFile(absolutePath, "utf8");
			if (computeFileHash(live) !== snap.tag) {
				throw new Error(
					`Write refused: ${shown} changed on disk since tag #${unwrapped.tag} was issued. ` +
						`Read it again to see the current content, then rewrite using the plain path.`,
				);
			}
		}
	} else if (exists) {
		// Untagged: drift guard against out-of-band changes since the last read.
		const head = snapshots.head(absolutePath);
		if (head && size <= MAX_GUARD_BYTES) {
			const live = await readFile(absolutePath, "utf8");
			if (computeFileHash(live) !== head.tag) {
				throw new Error(
					`Write refused: ${shown} changed on disk since the last read (tag #${head.tag} no longer matches). ` +
						`Read it again to see the current content, then rewrite using the plain path.`,
				);
			}
		} else if (!head) {
			notes.push(`Note: overwrote existing file that was never read this session.`);
		}
	} else if (unwrapped.tag) {
		// New file addressed with a tag: nothing to validate — say which reading won.
		notes.push(
			`Note: created ${shown} — the passed tag #${unwrapped.tag} was ignored (file did not exist). ` +
				`If you meant a literal filename ending in #${unwrapped.tag}, create it via bash.`,
		);
	}

	const stripped = stripEchoedPrefixes(params.content);
	if (stripped.stripped) {
		notes.push(`Note: auto-stripped hashline display prefixes (N:) from content before writing.`);
	}

	const delegate = createWriteTool(ctx.cwd);
	const result = await delegate.execute(
		toolCallId,
		{ path: targetPath, content: stripped.text },
		signal,
		onUpdate as never,
	);

	// Post-commit snapshot: follow-up edits validate without a re-read.
	let header: string | undefined;
	if (Buffer.byteLength(stripped.text, "utf8") <= MAX_GUARD_BYTES) {
		const tag = snapshots.record(absolutePath, stripped.text);
		header = formatHeader(shown, tag);
	}
	const tagOnTag = tagOnTagNote(shown);
	if (tagOnTag) notes.push(tagOnTag);

	const first = result.content.find((c): c is { type: "text"; text: string } => c.type === "text");
	if (first) {
		let text = first.text;
		if (header) text = `${header}\n${text}`;
		if (notes.length > 0) text = `${text}\n${notes.join("\n")}`;
		first.text = text;
	}
	return result;
}
