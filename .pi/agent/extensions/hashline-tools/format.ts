/**
 * Hashline format primitives: file tags, line prefixes, header (un)wrapping,
 * and echo-stripping for content the model copies out of read output.
 *
 * Wire format (OMP-style):
 *   [src/foo.ts#1A2B]        <- section header: cwd-relative path + 4-hex tag
 *   12:const x = 1;          <- N: line prefixes
 *
 * The tag is a 16-bit fingerprint of the whole file's normalized text.
 * It is an INDEX into the snapshot store, never an identity: identity is
 * always established by full-text comparison (16-bit tags collide).
 */

import { createHash } from "node:crypto";
import { isAbsolute, relative } from "node:path";

export const TAG_LENGTH = 4;

/** Strip trailing whitespace per line so CRLF endings / display-trimmed lines never invalidate a tag. */
export function normalizeForHash(text: string): string {
	return text.replace(/[ \t\r]+(?=\n|$)/g, "");
}

/** Content-derived 4-hex-uppercase tag for a whole file body. */
export function computeFileHash(text: string): string {
	return createHash("sha256").update(normalizeForHash(text), "utf8").digest("hex").slice(0, TAG_LENGTH).toUpperCase();
}

/** `[path#TAG]` header line. */
export function formatHeader(displayPath: string, tag: string): string {
	return `[${displayPath}#${tag}]`;
}

const TAG_RE = /^[0-9A-Fa-f]{4}$/;

/** Trailing '#…' run of 1-8 alphanumerics (+ optional ']') — clearly a tag attempt. */
const TAG_LIKE_RE = /#[0-9A-Za-z]{1,8}\]?$/;

export interface UnwrappedPath {
	/** Real filesystem path (brackets/tag stripped). Absent when `malformed` is set. */
	path?: string;
	/** Uppercased 4-hex tag, when one parsed. */
	tag?: string;
	/** Why this tag-like input was refused. Callers must deny — never use the raw string as a literal filename. */
	malformed?: string;
}

/**
 * Shared header parser for read/write/edit. Accepts:
 *   path            plain (relative or absolute)
 *   path#TAG        bare tagged form (models strip the "placeholder" brackets)
 *   [path#TAG]      canonical header as read prints it
 * The tag splits at the LAST '#', so paths containing '#' round-trip.
 *
 * A string that looks like a header but doesn't parse (bad tag characters or
 * length, unbalanced brackets) is returned as `malformed` — the old behavior
 * passed it through as a literal path, which is how stray files named
 * `SKILL.md#BFE8` got written. A '#' that is not a trailing tag-like
 * fragment ("notes#1.md") stays a plain path.
 */
export function unwrapHeaderPath(raw: string): UnwrappedPath {
	const input = raw.trim();
	if (!input.includes("#")) return { path: input };

	let inner = input;
	if (inner.startsWith("[") && inner.endsWith("]") && inner.length > 2) {
		inner = inner.slice(1, -1);
	} else if (inner.startsWith("[") || inner.endsWith("]")) {
		return { malformed: "unbalanced brackets — copy the header exactly as read printed it, e.g. [src/foo.ts#A1B2]" };
	}

	const hash = inner.lastIndexOf("#");
	const base = inner.slice(0, hash);
	const frag = inner.slice(hash + 1);
	if (TAG_RE.test(frag)) {
		if (base.length === 0) return { malformed: `missing the path before "#${frag}" (expected [path#TAG])` };
		return { path: base, tag: frag.toUpperCase() };
	}
	if (TAG_LIKE_RE.test(input)) {
		return {
			malformed: `"#${frag}" is not a valid tag — a tag is exactly 4 hex characters, like the A1B2 in [src/foo.ts#A1B2]`,
		};
	}
	return { path: input };
}

const TRAILING_TAG_RE = /#([0-9A-Fa-f]{4})$/;

/**
 * Note for the tag-on-tag anomaly: the real path itself ends in #XXXX, so the
 * emitted header shows two tags ([foo#AB12#CDEF]). That anomaly used to pass
 * silently — it was the only visible signal of the stray-literal-file bug.
 */
export function tagOnTagNote(shown: string): string | undefined {
	const m = shown.match(TRAILING_TAG_RE);
	if (!m) return undefined;
	return `Note: the path itself ends in #${m[1]}, so the header above shows two tags — the file is ${shown}.`;
}

/** Path shown in headers: cwd-relative when inside the workspace, absolute otherwise. */
export function displayPath(absolutePath: string, cwd: string): string {
	if (isAbsolute(absolutePath)) {
		const rel = relative(cwd, absolutePath);
		if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
	}
	return absolutePath;
}

const ECHO_PREFIX_RE = /^\d+[:|]/;
const LOOSE_HEADER_RE = /^\s*\[[^\]#\r\n]+#[0-9A-Fa-f]{4}\]\s*$/;

/**
 * Strict echo-stripping (OMP prefixes.ts parity): only strips when EVERY
 * non-empty content line carries an `N:` / `N|` prefix — i.e. the model pasted
 * read output back as file content. A header line, if present, is dropped.
 * Anything less uniform is returned untouched: false positives corrupt files.
 */
export function stripEchoedPrefixes(content: string): { text: string; stripped: boolean } {
	const lines = content.split("\n");
	const body = lines.filter((l) => l.length > 0 && !LOOSE_HEADER_RE.test(l));
	if (body.length === 0) return { text: content, stripped: false };
	if (!body.every((l) => ECHO_PREFIX_RE.test(l))) return { text: content, stripped: false };
	const cleaned = lines
		.filter((l) => !(l.trim().length > 0 && LOOSE_HEADER_RE.test(l.trim())))
		.map((l) => (l.length > 0 ? l.replace(ECHO_PREFIX_RE, "") : l));
	return { text: cleaned.join("\n"), stripped: true };
}
