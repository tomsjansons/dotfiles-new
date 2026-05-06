import { createHash } from "node:crypto";
import { extname, resolve } from "node:path";

const HASH_ALPHABET = "ZPMQVRWSNKTXJBYH";
const SIGNIFICANT_RE = /[A-Za-z0-9]/;
const HASHLINE_PREFIX_RE = new RegExp(`^\\s*\\d+\\s*#\\s*[${HASH_ALPHABET}]{2}\\s*:`);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

export function normalizePath(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
}

export function normalizeHashlinePath(path: string): string {
	return normalizePath(path);
}

export function resolvePath(cwd: string, path: string): string {
	return resolve(cwd, normalizePath(path));
}

export function resolveHashlinePath(cwd: string, path: string): string {
	return resolvePath(cwd, path);
}

export function isImagePath(path: string): boolean {
	return IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
}

export function textToLines(text: string): string[] {
	if (text === "") return [];
	return text.split("\n");
}

export function stripBom(text: string): { bom: string; text: string } {
	return text.startsWith("\uFEFF") ? { bom: "\uFEFF", text: text.slice(1) } : { bom: "", text };
}

export function detectLineEnding(text: string): "\n" | "\r\n" {
	return text.includes("\r\n") ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, lineEnding: "\n" | "\r\n"): string {
	return lineEnding === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function normalizeHashInput(line: string): string {
	return line.replace(/\r/g, "").replace(/[ \t]+$/g, "");
}

export function computeLineHash(lineNumber: number, line: string): string {
	const normalized = normalizeHashInput(line);
	const seed = SIGNIFICANT_RE.test(normalized) ? 0 : lineNumber;
	const digest = createHash("sha1").update(String(seed)).update("\0").update(normalized).digest();
	const byte = digest[0] ?? 0;
	return `${HASH_ALPHABET[(byte >> 4) & 0x0f]}${HASH_ALPHABET[byte & 0x0f]}`;
}

export function formatHashLine(lineNumber: number, line: string): string {
	return `${lineNumber}#${computeLineHash(lineNumber, line)}:${line.replace(/\r$/, "")}`;
}

export function stripHashlinePrefix(line: string): string {
	return line.replace(HASHLINE_PREFIX_RE, "");
}

export function prefixHashLines(lines: string[], startLineNumber: number): string {
	return lines.map((line, index) => formatHashLine(startLineNumber + index, line)).join("\n");
}

export function buildHashlinePreview(
	raw: string,
	options: { offset?: number; limit?: number } = {},
): { totalFileLines: number; selectedLines: string[]; anchored: string; startLine: number } {
	const text = normalizeToLF(raw);
	const allLines = textToLines(text);
	const totalFileLines = allLines.length;
	const startIndex = options.offset ? Math.max(0, options.offset - 1) : 0;
	if (startIndex > allLines.length - 1 && !(allLines.length === 0 && startIndex === 0)) {
		throw new Error(`Offset ${options.offset} is beyond end of file (${totalFileLines} lines total)`);
	}

	const endIndex = options.limit ? startIndex + Math.max(0, options.limit) : allLines.length;
	const selectedLines = allLines.slice(startIndex, endIndex).map((line) => line.replace(/\r$/, ""));
	return {
		totalFileLines,
		selectedLines,
		anchored: prefixHashLines(selectedLines, startIndex + 1),
		startLine: startIndex + 1,
	};
}

export function stripHashlinePrefixesFromText(text: string): string {
	return text
		.split("\n")
		.map((line) => stripHashlinePrefix(line))
		.join("\n");
}
