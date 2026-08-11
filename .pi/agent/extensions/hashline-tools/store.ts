/**
 * Per-process snapshot store: binds hashline tags to the exact file text that
 * minted them, plus per-version `seenLines` provenance (which 1-indexed lines
 * each read actually displayed).
 *
 * Port of oh-my-pi's InMemorySnapshotStore semantics:
 * - LRU over paths (bounded count and total retained text)
 * - per-path ring of distinct content versions, newest first
 * - record() fuses reads of identical content onto the existing version
 *   (promoting it and unioning seenLines) instead of minting duplicates
 * - dedup requires FULL-TEXT equality, not tag equality: the 16-bit tag is a
 *   fast index only, collisions are retained as separate versions
 *
 * Eviction fails closed: an evicted tag resolves to null and callers deny with
 * a named recovery (re-read). Never guess.
 */

import { computeFileHash } from "./format";

export interface Snapshot {
	/** Canonical (absolute) path this version belongs to. */
	readonly path: string;
	/** Full file text as observed (BOM-stripped, line endings as on disk). */
	readonly text: string;
	/** Content tag (see computeFileHash). */
	readonly tag: string;
	/**
	 * 1-indexed lines a read actually DISPLAYED under this version; unioned
	 * across reads of identical content. `undefined` = no provenance recorded
	 * (full write / post-edit snapshot) → callers skip the seen-line check.
	 */
	seenLines?: Set<number>;
	recordedAt: number;
}

export interface SnapshotStoreOptions {
	maxPaths?: number; // default 30
	maxVersionsPerPath?: number; // default 4
	maxTotalChars?: number; // default 64Mi chars
}

export class SnapshotStore {
	readonly #versions = new Map<string, Snapshot[]>();
	readonly #maxPaths: number;
	readonly #maxVersions: number;
	readonly #maxTotalChars: number;
	#totalChars = 0;

	constructor(options: SnapshotStoreOptions = {}) {
		this.#maxPaths = options.maxPaths ?? 30;
		this.#maxVersions = options.maxVersionsPerPath ?? 4;
		this.#maxTotalChars = options.maxTotalChars ?? 64 * 1024 * 1024;
	}

	/** Most-recently recorded version for `path`, refreshing LRU recency. */
	head(path: string): Snapshot | null {
		const history = this.#versions.get(path);
		if (!history) return null;
		this.#touch(path, history);
		return history[0] ?? null;
	}

	/** Recorded version for `path` whose tag matches; most-recent on collision. */
	byHash(path: string, tag: string): Snapshot | null {
		const history = this.#versions.get(path);
		if (!history) return null;
		this.#touch(path, history);
		return history.find((v) => v.tag === tag) ?? null;
	}

	/**
	 * Record an observation of `path`'s full text and return its tag.
	 * Identical content fuses onto the existing version (promote + union
	 * seenLines); changed content unshifts a new version, dropping the oldest
	 * beyond the per-path cap.
	 */
	record(path: string, text: string, seenLines?: Iterable<number>): string {
		const tag = computeFileHash(text);
		let history = this.#versions.get(path);
		if (history) {
			// Full-text equality, NOT tag equality — colliding tags on distinct
			// texts are different snapshots and must stay separate.
			const existing = history.find((v) => v.text === text);
			if (existing) {
				existing.recordedAt = Date.now();
				mergeSeenLines(existing, seenLines);
				if (history[0] !== existing) {
					history = [existing, ...history.filter((v) => v !== existing)];
					this.#versions.set(path, history);
				}
				this.#touch(path, history);
				return tag;
			}
		} else {
			history = [];
			this.#totalChars += 1; // path overhead
		}

		const snapshot: Snapshot = { path, text, tag, recordedAt: Date.now() };
		mergeSeenLines(snapshot, seenLines);
		const next = [snapshot, ...history].slice(0, this.#maxVersions);
		// size accounting: adjust for dropped tail versions
		this.#totalChars += snapshot.text.length;
		for (const dropped of history.slice(next.length - 1)) this.#totalChars -= dropped.text.length;
		this.#versions.set(path, next);
		this.#touch(path, next);
		this.#evict();
		return tag;
	}

	/** Union `lines` into the seenLines of the version carrying `tag`. No-op if aged out. */
	recordSeenLines(path: string, tag: string, lines: Iterable<number>): void {
		const version = this.#versions.get(path)?.find((v) => v.tag === tag);
		if (version) mergeSeenLines(version, lines);
	}

	invalidate(path: string): void {
		const history = this.#versions.get(path);
		if (!history) return;
		for (const v of history) this.#totalChars -= v.text.length;
		this.#versions.delete(path);
	}

	clear(): void {
		this.#versions.clear();
		this.#totalChars = 0;
	}

	get size(): number {
		return this.#versions.size;
	}

	#touch(path: string, history: Snapshot[]): void {
		this.#versions.delete(path);
		this.#versions.set(path, history);
	}

	#evict(): void {
		while (
			this.#versions.size > this.#maxPaths ||
			(this.#totalChars > this.#maxTotalChars && this.#versions.size > 1)
		) {
			const eldest = this.#versions.keys().next().value;
			if (eldest === undefined) break;
			this.invalidate(eldest);
		}
	}
}

function mergeSeenLines(snapshot: Snapshot, lines: Iterable<number> | undefined): void {
	if (lines === undefined) return;
	if (snapshot.seenLines === undefined) snapshot.seenLines = new Set<number>();
	for (const line of lines) snapshot.seenLines.add(line);
}

/** One store per extension load (pi process). `/reload` wipes it — every outstanding tag then denies with a re-read note. Bounded, self-healing. */
export const snapshots = new SnapshotStore();
