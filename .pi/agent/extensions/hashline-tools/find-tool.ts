import { Dirent } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import ignore from "ignore";

import {
	buildHashlinePreview,
	formatHashLine,
	isImagePath,
	normalizePath,
	normalizeToLF,
	resolvePath,
	textToLines,
} from "./hashline.ts";

const FIND_IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".piignore"] as const;
const FIND_DEFAULT_IGNORE_RULES = [".git/", ".jj/", ".svn/", "node_modules/"] as const;
const FIND_FALLBACK_PREVIEW_START = 1;
const FIND_FALLBACK_PREVIEW_LIMIT = 20;

const findSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to search from (relative or absolute, default .)" })),
	pattern: Type.Optional(Type.String({ description: "Glob pattern for matching files (default **)" })),
	"max-file-count": Type.Optional(Type.Number({ description: "Maximum number of matching files to include (default 200)" })),
});

function sortDirents(entries: Dirent[]): Dirent[] {
	return [...entries].sort((a, b) => a.name.localeCompare(b.name));
}

function toDisplayPath(rootAbsolutePath: string, displayRoot: string, absolutePath: string): string {
	const rel = relative(rootAbsolutePath, absolutePath).split("\\").join("/");
	const normalizedRoot = normalizePath(displayRoot).replace(/[\\/]+$/g, "").split("\\").join("/") || ".";
	return rel ? `${normalizedRoot}/${rel}` : normalizedRoot;
}

function toMatchPath(rootAbsolutePath: string, absolutePath: string): string {
	return relative(rootAbsolutePath, absolutePath).split("\\").join("/");
}

type IgnoreMatcher = {
	baseRelativePath: string;
	matcher: ReturnType<typeof ignore>;
};

function trimTrailingSlash(path: string): string {
	return path.replace(/\/+$/g, "");
}

function normalizeMatchCandidate(path: string): string {
	return path.split("\\").join("/").replace(/^\.\//, "");
}

function toMatcherRelativePath(relativePath: string, baseRelativePath: string): string | null {
	const normalizedRelativePath = trimTrailingSlash(normalizeMatchCandidate(relativePath));
	const normalizedBasePath = trimTrailingSlash(normalizeMatchCandidate(baseRelativePath));
	if (!normalizedBasePath) return normalizedRelativePath;
	if (normalizedRelativePath === normalizedBasePath) return "";
	const prefix = `${normalizedBasePath}/`;
	if (!normalizedRelativePath.startsWith(prefix)) return null;
	return normalizedRelativePath.slice(prefix.length);
}

async function loadIgnoreMatcher(baseRelativePath: string, absoluteDirectoryPath: string): Promise<IgnoreMatcher | undefined> {
	let combinedRules = "";
	for (const fileName of FIND_IGNORE_FILE_NAMES) {
		try {
			const raw = await readFile(resolve(absoluteDirectoryPath, fileName), "utf8");
			if (raw.trim() === "") continue;
			combinedRules += `${combinedRules ? "\n" : ""}${normalizeToLF(raw)}`;
		} catch (error: any) {
			if (error?.code !== "ENOENT") throw error;
		}
	}
	if (!combinedRules) return undefined;
	return {
		baseRelativePath,
		matcher: ignore().add(combinedRules),
	};
}

function shouldIgnorePath(relativePath: string, isDirectory: boolean, matchers: IgnoreMatcher[]): boolean {
	const normalizedRelativePath = trimTrailingSlash(normalizeMatchCandidate(relativePath));
	let ignored = false;
	for (const { baseRelativePath, matcher } of matchers) {
		const matcherRelativePath = toMatcherRelativePath(normalizedRelativePath, baseRelativePath);
		if (matcherRelativePath == null || matcherRelativePath === "") continue;
		const candidates = isDirectory ? [matcherRelativePath, `${matcherRelativePath}/`] : [matcherRelativePath];
		for (const candidate of candidates) {
			const result = (matcher as any).test?.(candidate);
			if (result && (result.ignored || result.unignored)) {
				ignored = !!result.ignored;
				continue;
			}
			if (matcher.ignores(candidate)) ignored = true;
		}
	}
	return ignored;
}

async function collectDirectoryFiles(
	absoluteDirectoryPath: string,
	directoryRelativePath = "",
	parentMatchers: IgnoreMatcher[] = [{ baseRelativePath: "", matcher: ignore().add(FIND_DEFAULT_IGNORE_RULES) }],
): Promise<string[]> {
	const localMatcher = await loadIgnoreMatcher(directoryRelativePath, absoluteDirectoryPath);
	const matchers = localMatcher ? [...parentMatchers, localMatcher] : parentMatchers;
	const entries = sortDirents(await readdir(absoluteDirectoryPath, { withFileTypes: true }));
	let files: string[] = [];
	for (const entry of entries) {
		const absolutePath = resolve(absoluteDirectoryPath, entry.name);
		const relativePath = normalizeMatchCandidate(directoryRelativePath ? `${directoryRelativePath}/${entry.name}` : entry.name);
		if (shouldIgnorePath(relativePath, entry.isDirectory(), matchers)) continue;
		if (entry.isDirectory()) {
			files = files.concat(await collectDirectoryFiles(absolutePath, relativePath, matchers));
			continue;
		}
		if (entry.isFile()) files.push(absolutePath);
	}
	return files;
}

function escapeRegex(text: string): string {
	return text.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
	let regex = "^";
	for (let index = 0; index < pattern.length; ) {
		const char = pattern[index];
		const next = pattern[index + 1];
		if (char === "*" && next === "*") {
			regex += ".*";
			index += 2;
			continue;
		}
		if (char === "*") {
			regex += "[^/]*";
			index += 1;
			continue;
		}
		if (char === "?") {
			regex += "[^/]";
			index += 1;
			continue;
		}
		regex += escapeRegex(char);
		index += 1;
	}
	regex += "$";
	return new RegExp(regex);
}

function matchesPattern(displayPath: string, relativePath: string, pattern: string): boolean {
	const normalizedPattern = pattern.trim() || "**";
	const regex = globToRegExp(normalizedPattern.split("\\").join("/"));
	const candidates = [displayPath, relativePath, normalizeMatchCandidate(displayPath), normalizeMatchCandidate(relativePath)].filter(
		(value, index, values) => value !== "" && values.indexOf(value) === index,
	);
	if (!normalizedPattern.includes("/")) {
		return candidates.some((candidate) => regex.test(candidate.split("/").pop() ?? candidate));
	}
	return candidates.some((candidate) => regex.test(candidate));
}

type OutlineEntry = {
	name: string;
	line: number;
	kind?: number;
};

async function requestOutline(pi: ExtensionAPI, file: string, timeoutMs = 1500): Promise<OutlineEntry[]> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("Timed out waiting for LSP outline")), timeoutMs);
		pi.events.emit("pi-lsp:outline-request", {
			file,
			resolve: (value: OutlineEntry[]) => {
				clearTimeout(timer);
				resolve(Array.isArray(value) ? value : []);
			},
			reject: (error: unknown) => {
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			},
		});
	});
}

function isProbablyTextBuffer(buffer: Buffer, path: string): boolean {
	if (isImagePath(path)) return false;
	if (buffer.includes(0)) return false;
	if (buffer.length === 0) return true;

	let suspicious = 0;
	const sampleLength = Math.min(buffer.length, 4096);
	for (let index = 0; index < sampleLength; index++) {
		const byte = buffer[index] ?? 0;
		const isControl = byte < 32 && byte !== 9 && byte !== 10 && byte !== 13;
		if (isControl) suspicious++;
	}
	return suspicious / sampleLength < 0.1;
}

function buildOutlineHashPreview(
	raw: string,
	outline: OutlineEntry[],
): { totalFileLines: number; lines: string[]; usedOutline: boolean } {
	const text = normalizeToLF(raw);
	const allLines = textToLines(text);
	const totalFileLines = allLines.length;
	const deduped = new Set<number>();
	const availableOutline = outline.filter(
		(entry) => entry.line >= 1 && entry.line <= totalFileLines && !deduped.has(entry.line) && deduped.add(entry.line),
	);
	if (availableOutline.length > 0) {
		const outlineLines = availableOutline.map((entry) => {
			const sourceLine = allLines[entry.line - 1] ?? "";
			return formatHashLine(entry.line, sourceLine);
		});
		return { totalFileLines, lines: outlineLines, usedOutline: true };
	}
	const fallback = buildHashlinePreview(raw, {
		offset: FIND_FALLBACK_PREVIEW_START,
		limit: FIND_FALLBACK_PREVIEW_LIMIT,
	});
	return { totalFileLines, lines: fallback.anchored ? fallback.anchored.split("\n") : [], usedOutline: false };
}

export function registerFindTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "find",
		label: "find",
		description:
			"Find files in a directory and show the full first-level LSP outline for each matching text file with hashline prefixes. Falls back to a hashline preview of lines 1-20 only when the file has no LSP outline.",
		promptSnippet: "Prefer this find tool over bash find when inspecting code directories",
		promptGuidelines: [
			"Prefer this find tool over bash find when the user wants to inspect files in a code directory.",
			"Use pattern to filter files, for example *.ts or src/**/*.rs.",
			"This tool always shows the full first-level LSP outline for the whole file when available, with hashline-prefixed source lines.",
			"If there is no outline, it falls back to hashline preview lines 1-20.",
		],
		parameters: findSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const searchPath = normalizePath(params.path ?? ".");
			const absolutePath = resolvePath(ctx.cwd, searchPath);
			const displayRoot = searchPath.replace(/[\\/]+$/g, "") || ".";
			const pattern = (params.pattern ?? "**").trim() || "**";
			const fileLimit = params["max-file-count"] ?? 200;
			if (signal?.aborted) throw new Error("Operation aborted");
			await access(absolutePath);

			let absoluteFiles: string[];
			try {
				absoluteFiles = await collectDirectoryFiles(absolutePath);
			} catch (error: any) {
				if (error?.code === "ENOTDIR") throw new Error(`Path is not a directory: ${searchPath}`);
				throw error;
			}

			const matchedFiles = absoluteFiles
				.map((absoluteFile) => ({
					absolute: absoluteFile,
					display: toDisplayPath(absolutePath, displayRoot, absoluteFile),
					relative: toMatchPath(absolutePath, absoluteFile),
				}))
				.filter((file) => matchesPattern(file.display, file.relative, pattern))
				.sort((a, b) => a.display.localeCompare(b.display));

			const files = matchedFiles.slice(0, fileLimit);
			const sections: string[] = [`--- ${displayRoot} files ---`, ...files.map((file) => `   ${file.display}`)];

			for (const file of files) {
				if (signal?.aborted) throw new Error("Operation aborted");
				const buffer = await readFile(file.absolute);
				sections.push("");

				if (!isProbablyTextBuffer(buffer, file.display)) {
					sections.push(`   --- ${file.display} ---`);
					sections.push("   [binary or image file skipped]");
					continue;
				}

				let outline: OutlineEntry[] = [];
				try {
					outline = await requestOutline(pi, file.absolute);
				} catch {
					outline = [];
				}

				const preview = buildOutlineHashPreview(buffer.toString("utf8"), outline);
				const fallbackStartLine = FIND_FALLBACK_PREVIEW_START;
				const fallbackEndLine = preview.totalFileLines > 0
					? Math.min(preview.totalFileLines, fallbackStartLine + FIND_FALLBACK_PREVIEW_LIMIT - 1)
					: 0;
				const headerLabel = preview.usedOutline
					? "lsp outline"
					: preview.totalFileLines > 0
						? `lines ${fallbackStartLine}-${fallbackEndLine}${preview.totalFileLines > fallbackEndLine ? ` of ${preview.totalFileLines}` : ""}; fallback preview`
						: "empty file";
				sections.push(`   --- ${file.display} (${headerLabel}) ---`);
				if (preview.lines.length === 0) {
					sections.push("   [empty file]");
					continue;
				}
				for (const line of preview.lines) sections.push(`   ${line}`);
			}

			const combined = sections.join("\n");
			const truncation = truncateHead(combined, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
			return {
				content: [{ type: "text" as const, text: truncation.content }],
				details: {
					fileCount: files.length,
					matchedCount: matchedFiles.length,
					pattern,
					...(matchedFiles.length > fileLimit ? { resultLimitReached: matchedFiles.length } : {}),
					...(truncation.truncated ? { truncation } : {}),
				},
			};
		},
		renderCall(args, theme) {
			const pathValue = String((args as any)?.path ?? ".");
			const pattern = String((args as any)?.pattern ?? "**");
			let text = theme.fg("toolTitle", theme.bold("find "));
			text += theme.fg("accent", pathValue);
			text += theme.fg("dim", ` -name ${pattern}`);
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) return new Text(theme.fg("warning", "Finding files..."), 0, 0);
			const content = result.content[0];
			const details = (result.details ?? {}) as {
				fileCount?: number;
				matchedCount?: number;
				pattern?: string;
				resultLimitReached?: number;
				truncation?: { truncated: boolean; totalLines?: number };
			};
			if (context.isError || (content?.type === "text" && /^error/i.test(content.text))) {
				const fullMessage = content?.type === "text" ? content.text : "find failed";
				const lines = fullMessage.split("\n");
				const previewLimit = expanded ? 40 : 12;
				let text = theme.fg("error", lines[0] ?? "find failed");
				for (const line of lines.slice(1, previewLimit)) text += `\n${theme.fg("dim", line)}`;
				if (lines.length > previewLimit) text += `\n${theme.fg("muted", expanded ? "... more error lines" : "... more error lines")}`;
				return new Text(text, 0, 0);
			}
			const outputLines = content?.type === "text" ? content.text.split("\n") : [];
			const visibleLineCount = expanded ? 80 : 12;
			let text = theme.fg("success", `${details.fileCount ?? 0} files`);
			if ((details.matchedCount ?? 0) > (details.fileCount ?? 0)) text += theme.fg("warning", ` of ${details.matchedCount}`);
			text += theme.fg("dim", ` · ${details.pattern ?? "**"}`);
			if (details.truncation?.truncated) text += theme.fg("warning", " [truncated]");
			for (const line of outputLines.slice(0, visibleLineCount)) {
				text += `\n${theme.fg("dim", line)}`;
			}
			if (outputLines.length > visibleLineCount) {
				text += `\n${theme.fg("muted", expanded ? "... more output lines" : "... more output lines")}`;
			}
			return new Text(text, 0, 0);
		},
	});
}
