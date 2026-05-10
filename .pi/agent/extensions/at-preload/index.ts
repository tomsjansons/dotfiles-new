import { Dirent } from "node:fs";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import ignore from "ignore";
import {
  buildHashlinePreview,
  resolveHashlinePath,
} from "../hashline-tools/index.ts";

const CONTEXT_TYPE = "at-preload-context";
const FILE_PRELOAD_LIMIT = 1000;
const DIRECTORY_PRELOAD_ROW_LIMIT = 100;
const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".svg",
  ".bmp",
  ".ico",
  ".avif",
]);
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".piignore"] as const;
const DEFAULT_IGNORE_RULES = [
  ".git/",
  ".jj/",
  ".svn/",
  "node_modules/",
] as const;
type PreloadItem =
  | {
      kind: "file";
      mention: string;
      requestedPath: string;
      resolvedPath: string;
      displayPath: string;
      totalLines: number;
      loadedLines: number;
      content: string;
    }
  | {
      kind: "directory";
      mention: string;
      requestedPath: string;
      resolvedPath: string;
      displayPath: string;
      entryCount: number;
      totalFiles: number;
      totalRows: number;
      loadedRows: number;
      content: string;
    }
  | {
      kind: "missing" | "unsupported" | "error";
      mention: string;
      requestedPath: string;
      resolvedPath?: string;
      displayPath: string;
      message: string;
    };

type PreloadMessageDetails = {
  items: Array<
    {
      kind: PreloadItem["kind"];
      mention: string;
      displayPath: string;
      totalLines?: number;
      loadedLines?: number;
      totalRows?: number;
      loadedRows?: number;
      totalFiles?: number;
      entryCount?: number;
      message?: string;
    }
  >;
  generatedAt: number;
};

type IgnoreMatcher = {
  baseRelativePath: string;
  matcher: ReturnType<typeof ignore>;
};


function isProbablyText(buffer: Buffer, path: string): boolean {
  const extension = extname(path).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return false;
  if (buffer.includes(0)) return false;
  if (buffer.length === 0) return true;

  let suspicious = 0;
  const sampleLength = Math.min(buffer.length, 4096);
  for (let i = 0; i < sampleLength; i++) {
    const byte = buffer[i] ?? 0;
    const isControl = byte < 32 && byte !== 9 && byte !== 10 && byte !== 13;
    if (isControl) suspicious++;
  }
  return suspicious / sampleLength < 0.1;
}

function resolveMentionPath(cwd: string, rawPath: string): string {
  if (rawPath === "~") return homedir();
  if (rawPath.startsWith(`~${sep}`) || rawPath.startsWith("~/")) {
    return resolve(homedir(), rawPath.slice(2));
  }
  return resolveHashlinePath(cwd, rawPath);
}

function toDisplayPath(cwd: string, absolutePath: string): string {
  const rel = relative(cwd, absolutePath);
  if (!rel || rel === "") return ".";
  if (!rel.startsWith(`..${sep}`) && rel !== "..") return rel;
  return absolutePath;
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[),.;:!?]+$/g, "");
}

function extractAtMentions(text: string): string[] {
  const mentions: string[] = [];
  const regex =
    /(^|[\s([{"'`])@(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([^\s\])},:;!?]+))/g;

  for (const match of text.matchAll(regex)) {
    const quoted = match[2] ?? match[3] ?? match[4];
    const bare = match[5];
    const value = quoted ?? stripTrailingPunctuation(bare ?? "");
    if (!value) continue;
    mentions.push(value);
  }

  return [...new Set(mentions)];
}

async function preloadFile(
  cwd: string,
  requestedPath: string,
): Promise<PreloadItem> {
  const resolvedPath = resolveMentionPath(cwd, requestedPath);
  const displayPath = toDisplayPath(cwd, resolvedPath);
  const buffer = await readFile(resolvedPath);

  if (!isProbablyText(buffer, resolvedPath)) {
    return {
      kind: "unsupported",
      mention: `@${requestedPath}`,
      requestedPath,
      resolvedPath,
      displayPath,
      message: "Binary or image file; skipped text preload.",
    };
  }

  const preview = buildHashlinePreview(buffer.toString("utf8"), {
    offset: 1,
    limit: FILE_PRELOAD_LIMIT,
  });

  return {
    kind: "file",
    mention: `@${requestedPath}`,
    requestedPath,
    resolvedPath,
    displayPath,
    totalLines: preview.totalFileLines,
    loadedLines: preview.selectedLines.length,
    content: preview.anchored,
  };
}

function sortDirents(entries: Dirent[]): Dirent[] {
  return [...entries].sort((a, b) => {
    const aDir = a.isDirectory() ? 0 : 1;
    const bDir = b.isDirectory() ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.localeCompare(b.name);
  });
}

function formatDirectoryPath(path: string): string {
  if (path === "/") return path;
  return `${path.replace(/[\\/]+$/g, "")}/`;
}

function joinDisplayPath(parent: string, child: string): string {
  if (parent === ".") return `./${child}`;
  return `${parent}/${child}`;
}

function normalizeIgnorePath(path: string): string {
  return path.split("\\").join("/");
}

function normalizeToLF(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function trimTrailingSlash(path: string): string {
  return path.replace(/\/+$/g, "");
}

function toMatcherRelativePath(
  relativePath: string,
  baseRelativePath: string,
): string | null {
  const normalizedRelativePath = trimTrailingSlash(
    normalizeIgnorePath(relativePath),
  );
  const normalizedBasePath = trimTrailingSlash(
    normalizeIgnorePath(baseRelativePath),
  );
  if (!normalizedBasePath) return normalizedRelativePath;
  if (normalizedRelativePath === normalizedBasePath) return "";
  const prefix = `${normalizedBasePath}/`;
  if (!normalizedRelativePath.startsWith(prefix)) return null;
  return normalizedRelativePath.slice(prefix.length);
}

async function loadIgnoreMatcher(
  baseRelativePath: string,
  absoluteDirectoryPath: string,
): Promise<IgnoreMatcher | undefined> {
  let combinedRules = "";
  for (const fileName of IGNORE_FILE_NAMES) {
    try {
      const raw = await readFile(
        resolve(absoluteDirectoryPath, fileName),
        "utf8",
      );
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

function shouldIgnorePath(
  relativePath: string,
  isDirectory: boolean,
  matchers: IgnoreMatcher[],
): boolean {
  const normalizedRelativePath = trimTrailingSlash(
    normalizeIgnorePath(relativePath),
  );
  let ignored = false;
  for (const { baseRelativePath, matcher } of matchers) {
    const matcherRelativePath = toMatcherRelativePath(
      normalizedRelativePath,
      baseRelativePath,
    );
    if (matcherRelativePath == null || matcherRelativePath === "") continue;
    const candidates = isDirectory
      ? [matcherRelativePath, `${matcherRelativePath}/`]
      : [matcherRelativePath];
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

type PathListState = {
  lines: string[];
  rowLimit: number;
  entryCount: number;
  totalFiles: number;
  totalRows: number;
};

function pushPathListLine(state: PathListState, line: string): void {
  state.totalRows++;
  if (state.lines.length < state.rowLimit) state.lines.push(line);
}

async function buildPathList(
  path: string,
  displayPath: string,
  directoryRelativePath = "",
  parentMatchers: IgnoreMatcher[] = [
    { baseRelativePath: "", matcher: ignore().add(DEFAULT_IGNORE_RULES) },
  ],
  state: PathListState = {
    lines: [],
    rowLimit: DIRECTORY_PRELOAD_ROW_LIMIT,
    entryCount: 0,
    totalFiles: 0,
    totalRows: 0,
  },
): Promise<PathListState> {
  const localMatcher = await loadIgnoreMatcher(directoryRelativePath, path);
  const matchers = localMatcher
    ? [...parentMatchers, localMatcher]
    : parentMatchers;
  const entries = sortDirents(await readdir(path, { withFileTypes: true }));

  for (const entry of entries) {
    const entryPath = resolve(path, entry.name);
    const entryRelativePath = normalizeIgnorePath(
      directoryRelativePath
        ? `${directoryRelativePath}/${entry.name}`
        : entry.name,
    );
    if (shouldIgnorePath(entryRelativePath, entry.isDirectory(), matchers))
      continue;
    const entryDisplayPath = joinDisplayPath(displayPath, entry.name);
    state.entryCount++;

    if (entry.isSymbolicLink()) {
      let target = "";
      try {
        target = await readlink(entryPath);
      } catch {
        target = "?";
      }
      pushPathListLine(state, `${entryDisplayPath}@ -> ${target}`);
      continue;
    }

    if (entry.isDirectory()) {
      pushPathListLine(state, formatDirectoryPath(entryDisplayPath));
      try {
        await buildPathList(
          entryPath,
          entryDisplayPath,
          entryRelativePath,
          matchers,
          state,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        pushPathListLine(
          state,
          `${formatDirectoryPath(entryDisplayPath)} [error: ${message}]`,
        );
      }
      continue;
    }

    if (entry.isFile()) state.totalFiles++;
    pushPathListLine(state, entryDisplayPath);
  }

  return state;
}

async function preloadDirectory(
  cwd: string,
  requestedPath: string,
): Promise<PreloadItem> {
  const resolvedPath = resolveMentionPath(cwd, requestedPath);
  const displayPath = toDisplayPath(cwd, resolvedPath);
  const rootLabel = formatDirectoryPath(
    displayPath === "." ? requestedPath || "." : displayPath,
  );
  const listing = await buildPathList(
    resolvedPath,
    rootLabel.slice(0, -1),
    "",
    undefined,
    {
      lines: [],
      rowLimit: DIRECTORY_PRELOAD_ROW_LIMIT - 1,
      entryCount: 0,
      totalFiles: 0,
      totalRows: 0,
    },
  );
  const lines = [rootLabel, ...listing.lines];
  const totalRows = listing.totalRows + 1;

  return {
    kind: "directory",
    mention: `@${requestedPath}`,
    requestedPath,
    resolvedPath,
    displayPath,
    entryCount: listing.entryCount,
    totalFiles: listing.totalFiles,
    totalRows,
    loadedRows: lines.length,
    content: lines.join("\n"),
  };
}

async function preloadMention(
  cwd: string,
  requestedPath: string,
): Promise<PreloadItem> {
  const resolvedPath = resolveMentionPath(cwd, requestedPath);
  const displayPath = toDisplayPath(cwd, resolvedPath);

  try {
    const stats = await lstat(resolvedPath);
    if (stats.isDirectory()) return preloadDirectory(cwd, requestedPath);
    if (stats.isFile()) return preloadFile(cwd, requestedPath);
    return {
      kind: "unsupported",
      mention: `@${requestedPath}`,
      requestedPath,
      resolvedPath,
      displayPath,
      message: "Not a regular file or directory.",
    };
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return {
        kind: "missing",
        mention: `@${requestedPath}`,
        requestedPath,
        resolvedPath,
        displayPath,
        message: "Path not found.",
      };
    }
    return {
      kind: "error",
      mention: `@${requestedPath}`,
      requestedPath,
      resolvedPath,
      displayPath,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildContextText(items: PreloadItem[]): string | undefined {
  if (items.length === 0) return undefined;

  const sections: string[] = [
    "The @-preload extension detected @path mentions in the user's prompt and preloaded them before this turn.",
    "File sections below use the same LINE#ID:content hashline style as the hashline read workflow.",
    `Directory sections below are plain ordered path lists capped at ${DIRECTORY_PRELOAD_ROW_LIMIT} rows.`,
    `If a directory preload is truncated, search within it or read specific files as needed. If you need fresh anchors or file lines outside 1-${FILE_PRELOAD_LIMIT}, call read yourself.`,
  ];

  for (const item of items) {
    if (item.kind === "file") {
      sections.push(
        [
          ``,
          `=== FILE ${item.mention} ===`,
          `Resolved path: ${item.displayPath}`,
          `Equivalent preload: read(path=${JSON.stringify(item.requestedPath)}, offset=1, limit=${FILE_PRELOAD_LIMIT})`,
          `Loaded lines: 1-${item.loadedLines}${item.totalLines > item.loadedLines ? ` of ${item.totalLines}` : ""}`,
          item.content || "[empty file]",
        ].join("\n"),
      );
      continue;
    }

    if (item.kind === "directory") {
      sections.push(
        [
          ``,
          `=== DIRECTORY ${item.mention} ===`,
          `Resolved path: ${item.displayPath}`,
          `Ordered path preload (showing ${item.loadedRows} of ${item.totalRows} rows; ${item.totalFiles} total files, ${item.entryCount} total entries):`,
          item.loadedRows < item.totalRows
            ? `Only the first ${DIRECTORY_PRELOAD_ROW_LIMIT} rows are loaded. Search this directory if you need more specific paths.\n${item.content}`
            : item.content,
        ].join("\n"),
      );
      continue;
    }

    sections.push(
      [
        ``,
        `=== ${item.kind.toUpperCase()} ${item.mention} ===`,
        `Resolved path: ${item.displayPath}`,
        item.message,
      ].join("\n"),
    );
  }

  return sections.join("\n");
}
function buildMessageDetails(items: PreloadItem[]): PreloadMessageDetails {
  return {
    generatedAt: Date.now(),
    items: items.map((item) => {
      if (item.kind === "file") {
        return {
          kind: item.kind,
          mention: item.mention,
          displayPath: item.displayPath,
          totalLines: item.totalLines,
          loadedLines: item.loadedLines,
        };
      }

      if (item.kind === "directory") {
        return {
          kind: item.kind,
          mention: item.mention,
          displayPath: item.displayPath,
          totalRows: item.totalRows,
          loadedRows: item.loadedRows,
          totalFiles: item.totalFiles,
          entryCount: item.entryCount,
        };
      }

      return {
        kind: item.kind,
        mention: item.mention,
        displayPath: item.displayPath,
        message: item.message,
      };
    }),
  };
}

type ToolStatus = "done" | "error";
const ROW_PREFIX = "    ";
const PRELOAD_ICON = "⇈";

function colorPreloadIcon(icon: string): string {
  return `\x1b[38;2;135;206;250m${icon}\x1b[39m`;
}

function statusIcon(status: ToolStatus, theme: any): string {
  switch (status) {
    case "done":
      return theme.fg("success", "✓");
    case "error":
      return theme.fg("error", "✗");
  }
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function mentionPath(item: PreloadMessageDetails["items"][number]): string {
  const path = item.mention.startsWith("@") ? item.mention.slice(1) : item.mention;
  return path || item.displayPath;
}

function formatFileRange(theme: any): string {
  return theme.fg("muted", `:1-${FILE_PRELOAD_LIMIT}`);
}

function formatDirectoryCounts(
  item: PreloadMessageDetails["items"][number],
  theme: any,
): string {
  const loadedRows = item.loadedRows ?? 0;
  const totalRows = item.totalRows ?? loadedRows;
  const totalEntries = item.entryCount ?? Math.max(0, totalRows - 1);
  const loadedEntries = Math.min(totalEntries, Math.max(0, loadedRows - 1));
  const truncatedEntries = Math.max(0, totalEntries - loadedEntries);
  const truncated =
    truncatedEntries > 0
      ? `, ${plural(truncatedEntries, "entry", "entries")} truncated`
      : "";
  return theme.fg(
    "muted",
    `(${plural(loadedEntries, "entry", "entries")} given to agent${truncated})`,
  );
}

function formatPreloadRow(
  item: PreloadMessageDetails["items"][number],
  theme: any,
): string {
  const ok = item.kind === "file" || item.kind === "directory";
  let text = `${ROW_PREFIX}${statusIcon(ok ? "done" : "error", theme)} ${colorPreloadIcon(
    PRELOAD_ICON,
  )} ${theme.fg("accent", mentionPath(item))}`;

  if (item.kind === "file") {
    text += formatFileRange(theme);
  } else if (item.kind === "directory") {
    text += ` ${formatDirectoryCounts(item, theme)}`;
  }

  if (!ok) text += ` ${theme.fg("error", item.message ?? "skipped")}`;
  return text;
}

function renderPreloadSummary(
  details: PreloadMessageDetails | undefined,
  _expanded: boolean,
  theme: any,
  content: unknown,
) {
  const items = details?.items ?? [];
  if (items.length === 0) {
    const fallbackText =
      typeof content === "string" && content.trim()
        ? "@-preload context injected; summary details are unavailable."
        : "@-preload context injected.";
    return new Text(
      `${ROW_PREFIX}${theme.fg("success", "✓")} ${colorPreloadIcon(PRELOAD_ICON)} ${theme.fg("accent", "@-preload")} ${theme.fg("muted", fallbackText)}`,
      0,
      0,
    );
  }

  return new Text(
    items.map((item) => formatPreloadRow(item, theme)).join("\n"),
    0,
    0,
  );
}

export default function atPreloadExtension(pi: ExtensionAPI) {
  pi.registerMessageRenderer(CONTEXT_TYPE, (message, { expanded }, theme) =>
    renderPreloadSummary(
      message.details as PreloadMessageDetails | undefined,
      expanded,
      theme,
      message.content,
    ),
  );

  pi.on("context", async (event) => {
    let lastContextIndex = -1;
    for (let i = 0; i < event.messages.length; i++) {
      const message = event.messages[i] as { customType?: string };
      if (message.customType === CONTEXT_TYPE) lastContextIndex = i;
    }

    return {
      messages: event.messages.filter((message, index) => {
        const customType = (message as { customType?: string }).customType;
        if (customType === CONTEXT_TYPE && index !== lastContextIndex)
          return false;
        return true;
      }),
    };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const mentions = extractAtMentions(event.prompt);
    if (mentions.length === 0) return undefined;

    const items = await Promise.all(
      mentions.map((mention) => preloadMention(ctx.cwd, mention)),
    );
    const contextText = buildContextText(items);

    if (!contextText) return undefined;
    return {
      message: {
        customType: CONTEXT_TYPE,
        content: contextText,
        display: true,
        details: buildMessageDetails(items),
      },
    };
  });

}
