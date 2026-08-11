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

const HEADER_PATH_RE = /^\[([^\]#\r\n]+)#([0-9A-Fa-f]{4})\]$/;

/**
 * Unwrap a `[path#TAG]`-wrapped tool path into its components.
 * Returns the input unchanged (with no tag) when it is not a header-wrapped path.
 */
export function unwrapHeaderPath(raw: string): { path: string; tag?: string } {
	const m = raw.trim().match(HEADER_PATH_RE);
	if (m) return { path: m[1], tag: m[2].toUpperCase() };
	return { path: raw };
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
