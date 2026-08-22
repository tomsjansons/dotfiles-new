/**
 * edit override: hashline validation around pi's oldText/newText edit.
 *
 * The path may carry a `[path#TAG]` header or a bare `path#TAG` suffix (shared
 * parser); tag-like paths that don't parse are refused with format guidance
 * instead of a bare ENOENT. When a tag is present:
 * - unknown tag      → deny: snapshot expired/evicted, re-read for a fresh tag
 * - tag ≠ live file  → deny: out-of-band drift; re-read for a fresh tag
 *   (v1: no anchor remapping — deny is cheap and always correct)
 * - tag matches      → seen-line enforcement: every edit's oldText is located
 *   in the live text, and its line span must lie within the lines some read
 *   actually displayed. Editing blind-spot lines is denied with the exact
 *   offset that fixes it.
 *
 * After a successful edit the new content is snapshotted with provenance
 * cleared (seenLines = undefined → skip check), mirroring OMP's post-commit
 * snapshot: a validated edit proves current-content knowledge, and the result
 * carries the fresh tag so chained edits need no re-read.
 *
 * Note: no withFileMutationQueue here — the built-in edit already participates
 * in the per-file queue internally, and wrapping a delegate call in the same
 * queue self-deadlocks (non-reentrant). Validation runs just before the
 * delegate's queued mutation; oldText matching guards the small TOCTOU window.
 */

import { createEditTool } from "@earendil-works/pi-coding-agent";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { computeFileHash, displayPath, formatHeader, tagOnTagNote, unwrapHeaderPath } from "./format";
import { snapshots } from "./store";

const MAX_GUARD_BYTES = 8 * 1024 * 1024;

interface EditParams {
	path: string;
	edits: { oldText: string; newText: string }[];
}

function lineOf(text: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
	return line;
}

export async function executeEdit(
	toolCallId: string,
	params: EditParams,
	signal: AbortSignal | undefined,
	onUpdate: unknown,
	ctx: { cwd: string },
) {
	const unwrapped = unwrapHeaderPath(params.path.replace(/^@/, ""));
	if (unwrapped.malformed || !unwrapped.path) {
		throw new Error(
			`Edit refused: ${JSON.stringify(params.path)} ${unwrapped.malformed ?? "could not be parsed"}. ` +
				`Pass the plain path, or copy the [path#TAG] header from read output verbatim (brackets optional).`,
		);
	}
	const targetPath: string = unwrapped.path;
	const absolutePath = resolve(ctx.cwd, targetPath);
	const shown = displayPath(absolutePath, ctx.cwd);

	if (unwrapped.tag) {
			const snap = snapshots.byHash(absolutePath, unwrapped.tag);
			if (!snap) {
				throw new Error(
					`Edit refused: tag #${unwrapped.tag} for ${shown} is not tracked (file changed or snapshot expired). ` +
						`Read the file again to get a fresh tag.`,
				);
			}
			const st = await stat(absolutePath);
			if (st.size <= MAX_GUARD_BYTES) {
				const live = await readFile(absolutePath, "utf8");
				if (computeFileHash(live) !== snap.tag) {
					throw new Error(
						`Edit refused: ${shown} changed on disk since tag #${unwrapped.tag} was issued. ` +
							`Read it again (a fresh tag will be issued) and retry the edit.`,
					);
				}
				if (snap.seenLines) {
					for (const e of params.edits) {
						const idx = live.indexOf(e.oldText);
						if (idx === -1) continue; // let the built-in edit produce its own not-found error
						const start = lineOf(live, idx);
						const end = lineOf(live, idx + e.oldText.length);
						const unseen: number[] = [];
						for (let n = start; n <= end; n++) if (!snap.seenLines.has(n)) unseen.push(n);
						if (unseen.length > 0) {
							throw new Error(
								`Edit refused: line${unseen.length > 1 ? "s" : ""} ${unseen[0]}${unseen.length > 1 ? `-${unseen[unseen.length - 1]}` : ""} ` +
									`of ${shown} ${unseen.length > 1 ? "were" : "was"} never shown in a read. ` +
									`Use read with offset=${unseen[0]} to view ${unseen.length > 1 ? "them" : "it"} first.`,
							);
						}
					}
				}
			}
		}

	const delegate = createEditTool(ctx.cwd);
	const result = await delegate.execute(
		toolCallId,
		{ path: unwrapped.path, edits: params.edits } as never,
		signal,
		onUpdate as never,
	);

	// Post-commit snapshot + fresh tag for chained edits.
	try {
		const st = await stat(absolutePath);
		if (st.isFile() && st.size <= MAX_GUARD_BYTES) {
			const after = await readFile(absolutePath, "utf8");
			const tag = snapshots.record(absolutePath, after);
			const first = result.content.find((c): c is { type: "text"; text: string } => c.type === "text");
			if (first) {
				let text = `${formatHeader(shown, tag)}\n${first.text}`;
				const tagOnTag = tagOnTagNote(shown);
				if (tagOnTag) text = `${text}\n${tagOnTag}`;
				first.text = text;
			}
		}
	} catch {
		/* snapshot bookkeeping must never fail an applied edit */
	}
	return result;
}
