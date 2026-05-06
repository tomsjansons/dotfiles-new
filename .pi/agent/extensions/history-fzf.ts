import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Focusable } from "@mariozechner/pi-tui";
import { Input, Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

interface HistoryItem {
  text: string;
  timestamp: number;
  entryId: string;
  sessionPath: string;
  sessionName?: string;
  cwd: string;
}

interface MatchResult {
  item: HistoryItem;
  score: number;
  positions: Set<number>;
}

type HistoryScope = "current" | "all";

interface HistorySelectorTheme {
  accent: (text: string) => string;
  muted: (text: string) => string;
  dim: (text: string) => string;
  match: (text: string) => string;
  border: (text: string) => string;
  bold: (text: string) => string;
}
interface CachedSessionMeta {
  cacheFile: string;
  size: number;
  mtimeMs: number;
  scannedAt: string;
  messageCount: number;
}

interface CacheManifest {
  version: 1;
  updatedAt: string;
  sessions: Record<string, CachedSessionMeta>;
}

interface RawSessionEntry {
  type?: string;
  id?: string;
  timestamp?: string;
  cwd?: string;
  name?: string;
  message?: {
    role?: string;
    content?: unknown;
    timestamp?: number;
  };
}

const MAX_VISIBLE = 14;
const MAX_TEXT_CHARS = 20_000;
const CACHE_VERSION = 1;
const CACHE_DIR = join(homedir(), ".pi", "agent", "history-fzf");
const CACHE_SESSIONS_DIR = join(CACHE_DIR, "sessions");
const MANIFEST_PATH = join(CACHE_DIR, "manifest.json");
const PI_SESSIONS_ROOT = join(homedir(), ".pi", "agent", "sessions");

export default function (pi: ExtensionAPI) {
  pi.registerCommand("history", {
    description: "Fuzzy find user messages across all pi sessions",
    handler: async (_args, ctx) => {
      await runHistoryFinder(ctx);
    },
  });

  pi.registerShortcut("ctrl+r", {
    description: "history: fuzzy find sent messages",
    handler: async (ctx) => {
      await runHistoryFinder(ctx);
    },
  });
}

async function runHistoryFinder(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("history search requires interactive mode", "error");
    return;
  }

  let items: HistoryItem[];
  ctx.ui.setStatus("history-fzf", ctx.ui.theme.fg("accent", "history: updating cache…"));
  try {
    items = await collectUserMessages();
  } catch (error) {
    ctx.ui.notify(`history: failed to load sessions: ${error instanceof Error ? error.message : String(error)}`, "error");
    return;
  } finally {
    ctx.ui.setStatus("history-fzf", undefined);
  }
  if (items.length === 0) {
    ctx.ui.notify("history: no user messages found", "warning");
    return;
  }

  const selected = await ctx.ui.custom<HistoryItem | null>(
    (tui, theme, _keybindings, done) => {
      const selector = new HistorySelector(
        items,
        ctx.cwd,
        {
          accent: (t) => theme.fg("accent", t),
          muted: (t) => theme.fg("muted", t),
          dim: (t) => theme.fg("dim", t),
          match: (t) => theme.fg("warning", theme.bold(t)),
          border: (t) => theme.fg("border", t),
          bold: (t) => theme.bold(t),
        },
        done,
      );

      return {
        render(width: number) {
          return selector.render(width);
        },
        invalidate() {
          selector.invalidate();
        },
        handleInput(data: string) {
          selector.handleInput(data);
          tui.requestRender();
        },
        get focused() {
          return selector.focused;
        },
        set focused(value: boolean) {
          selector.focused = value;
        },
      };
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "top-center",
        offsetY: 4,
        width: "88%",
        minWidth: 70,
        maxHeight: "80%",
      },
    },
  );

  if (selected) {
    ctx.ui.pasteToEditor(selected.text);
  }
}

async function collectUserMessages(): Promise<HistoryItem[]> {
  await ensureCacheDirs();

  const manifest = await loadManifest();
  const sessionPaths = await findSessionFiles(PI_SESSIONS_ROOT);
  const seen = new Set<string>();
  const items: HistoryItem[] = [];

  for (const sessionPath of sessionPaths) {
    seen.add(sessionPath);

    let sessionStat;
    try {
      sessionStat = await stat(sessionPath);
    } catch {
      continue;
    }

    const cached = manifest.sessions[sessionPath];
    if (
      cached &&
      cached.size === sessionStat.size &&
      cached.mtimeMs === sessionStat.mtimeMs &&
      (await fileExists(join(CACHE_SESSIONS_DIR, cached.cacheFile)))
    ) {
      items.push(...(await readCachedItems(join(CACHE_SESSIONS_DIR, cached.cacheFile))));
      continue;
    }

    const scanned = await scanSessionFile(sessionPath, sessionStat.mtimeMs);
    const cacheFile = cached?.cacheFile ?? `${hashPath(sessionPath)}.jsonl`;
    await writeSessionCache(join(CACHE_SESSIONS_DIR, cacheFile), scanned);

    manifest.sessions[sessionPath] = {
      cacheFile,
      size: sessionStat.size,
      mtimeMs: sessionStat.mtimeMs,
      scannedAt: new Date().toISOString(),
      messageCount: scanned.length,
    };

    items.push(...scanned);
  }

  for (const [sessionPath, cached] of Object.entries(manifest.sessions)) {
    if (seen.has(sessionPath)) continue;
    await unlink(join(CACHE_SESSIONS_DIR, cached.cacheFile)).catch(() => undefined);
    delete manifest.sessions[sessionPath];
  }

  manifest.updatedAt = new Date().toISOString();
  await saveManifest(manifest);

  items.sort((a, b) => b.timestamp - a.timestamp);
  return items;
}

async function ensureCacheDirs(): Promise<void> {
  await mkdir(CACHE_SESSIONS_DIR, { recursive: true });
}

async function loadManifest(): Promise<CacheManifest> {
  try {
    const parsed = JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as CacheManifest;
    if (parsed.version === CACHE_VERSION && parsed.sessions && typeof parsed.sessions === "object") {
      return parsed;
    }
  } catch {
    // Missing or invalid cache: rebuild lazily below.
  }

  return { version: CACHE_VERSION, updatedAt: new Date(0).toISOString(), sessions: {} };
}

async function saveManifest(manifest: CacheManifest): Promise<void> {
  const tmpPath = `${MANIFEST_PATH}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await rename(tmpPath, MANIFEST_PATH);
}

async function findSessionFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: string[] = [];
  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await findSessionFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      results.push(fullPath);
    }
  }
  return results;
}

async function scanSessionFile(sessionPath: string, fallbackTimestamp: number): Promise<HistoryItem[]> {
  let raw: string;
  try {
    raw = await readFile(sessionPath, "utf8");
  } catch {
    return [];
  }

  let cwd = "";
  let sessionName: string | undefined;
  const items: HistoryItem[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;

    let entry: RawSessionEntry;
    try {
      entry = JSON.parse(line) as RawSessionEntry;
    } catch {
      continue;
    }

    if (entry.type === "session") {
      cwd = typeof entry.cwd === "string" ? entry.cwd : "";
      continue;
    }

    if (entry.type === "session_info") {
      sessionName = typeof entry.name === "string" ? entry.name : undefined;
      continue;
    }

    if (entry.type !== "message" || entry.message?.role !== "user") continue;

    const text = contentToText(entry.message.content).trim();
    if (!text) continue;

    items.push({
      text: text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…` : text,
      timestamp: entry.message.timestamp || parseEntryTimestamp(entry.timestamp, fallbackTimestamp),
      entryId: entry.id || "",
      sessionPath,
      cwd,
    });
  }

  if (sessionName) {
    for (const item of items) item.sessionName = sessionName;
  } else {
    const fallbackName = basename(sessionPath, ".jsonl");
    for (const item of items) item.sessionName = fallbackName;
  }

  return items;
}

async function readCachedItems(cachePath: string): Promise<HistoryItem[]> {
  try {
    const raw = await readFile(cachePath, "utf8");
    const items: HistoryItem[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line) as HistoryItem;
      if (typeof parsed.text === "string" && typeof parsed.timestamp === "number") {
        items.push(parsed);
      }
    }
    return items;
  } catch {
    return [];
  }
}

async function writeSessionCache(cachePath: string, items: HistoryItem[]): Promise<void> {
  const tmpPath = `${cachePath}.tmp`;
  const body = items.map((item) => JSON.stringify(item)).join("\n");
  await writeFile(tmpPath, body ? `${body}\n` : "", "utf8");
  await rename(tmpPath, cachePath);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function hashPath(path: string): string {
  return createHash("sha1").update(path).digest("hex");
}

function parseEntryTimestamp(timestamp: string | undefined, fallback: number): number {
  if (!timestamp) return fallback;
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? fallback : parsed;
}


function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const typed = block as { type?: string; text?: string };
      if (typed.type === "text" && typeof typed.text === "string") return typed.text;
      if (typed.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

class HistorySelector implements Focusable {
  private readonly input = new Input();
  private readonly allItems: HistoryItem[];
  private readonly currentItems: HistoryItem[];
  private readonly currentCwd: string;
  private readonly theme: HistorySelectorTheme;
  private readonly done: (value: HistoryItem | null) => void;
  private scope: HistoryScope = "current";
  private filtered: MatchResult[] = [];
  private selectedIndex = 0;
  private previewScroll = 0;

  private cachedWidth?: number;
  private cachedLines?: string[];

  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  constructor(
    allItems: HistoryItem[],
    currentCwd: string,
    theme: HistorySelectorTheme,
    done: (value: HistoryItem | null) => void,
  ) {
    this.allItems = allItems;
    this.currentCwd = normalizeCwd(currentCwd);
    this.currentItems = allItems.filter((item) => normalizeCwd(item.cwd) === this.currentCwd);
    this.theme = theme;
    this.done = done;
    this.applyFilter("");
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p"))) {
      this.moveSelection(-1);
      return;
    }

    if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("n"))) {
      this.moveSelection(1);
      return;
    }

    if (matchesKey(data, Key.pageUp)) {
      this.moveSelection(-MAX_VISIBLE);
      return;
    }

    if (matchesKey(data, Key.pageDown)) {
      this.moveSelection(MAX_VISIBLE);
      return;
    }

    if (matchesKey(data, Key.alt("up"))) {
      this.previewScroll = Math.max(0, this.previewScroll - 5);
      this.invalidate();
      return;
    }

    if (matchesKey(data, Key.alt("down"))) {
      this.previewScroll += 5;
      this.invalidate();
      return;
    }

    if (matchesKey(data, Key.tab)) {
      this.toggleScope();
      return;
    }

    if (matchesKey(data, Key.enter)) {
      const selected = this.filtered[this.selectedIndex]?.item;
      if (selected) this.done(selected);
      return;
    }

    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.done(null);
      return;
    }

    const previous = this.input.getValue();
    this.input.handleInput(data);
    const next = this.input.getValue();

    if (next !== previous) {
      this.applyFilter(next);
      this.selectedIndex = 0;
      this.previewScroll = 0;
      this.invalidate();
    }
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;

    const t = this.theme;
    const innerWidth = Math.max(1, width - 2);
    const side = t.border("│");
    const lines: string[] = [];

    const scopedItems = this.getScopedItems();
    const scopeLabel = this.scope === "current" ? `dir ${shortCwd(this.currentCwd)}` : "all dirs";
    const countLabel = `${this.filtered.length}/${scopedItems.length} messages`;
    const allCountLabel = this.scope === "current" ? t.dim(` (${this.allItems.length} all)`) : "";
    lines.push(t.border("╭") + t.border("─".repeat(innerWidth)) + t.border("╮"));
    lines.push(
      boxLine(
        ` ${t.accent(t.bold("History"))} ${t.dim(countLabel)}${allCountLabel} ${t.accent(`[${scopeLabel}]`)}`,
        innerWidth,
        side,
      ),
    );

    for (const inputLine of this.input.render(innerWidth)) {
      lines.push(boxLine(inputLine, innerWidth, side));
    }

    lines.push(t.border("├") + t.border("─".repeat(innerWidth)) + t.border("┤"));

    const usePreviewPane = innerWidth >= 96;
    if (usePreviewPane) {
      this.renderTwoPane(lines, innerWidth, side);
    } else {
      this.renderSinglePane(lines, innerWidth, side);
    }

    lines.push(
      boxLine(t.dim(" tab dir/all • ↑↓/ctrl+p/n navigate • enter insert • esc cancel • alt+↑↓ preview"), innerWidth, side),
    );
    lines.push(t.border("╰") + t.border("─".repeat(innerWidth)) + t.border("╯"));

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.input.invalidate();
  }

  private moveSelection(delta: number): void {
    if (this.filtered.length === 0) return;
    const next = this.selectedIndex + delta;
    this.selectedIndex = Math.max(0, Math.min(this.filtered.length - 1, next));
    this.previewScroll = 0;
    this.invalidate();
  }

  private toggleScope(): void {
    this.scope = this.scope === "current" ? "all" : "current";
    this.applyFilter(this.input.getValue());
    this.selectedIndex = 0;
    this.previewScroll = 0;
    this.invalidate();
  }

  private getScopedItems(): HistoryItem[] {
    return this.scope === "current" ? this.currentItems : this.allItems;
  }

  private applyFilter(query: string): void {
    const sourceItems = this.getScopedItems();
    const trimmed = query.trim();
    if (!trimmed) {
      this.filtered = sourceItems.map((item, index) => ({
        item,
        score: index,
        positions: new Set<number>(),
      }));
      return;
    }

    this.filtered = sourceItems
      .map((item, index) => {
        const match = fuzzyMatch(item.text, trimmed);
        if (match) return { item, score: match.score, positions: match.positions };

        const metadataMatch = fuzzyMatch(searchMetadata(item), trimmed);
        if (!metadataMatch) return null;
        return {
          item,
          score: metadataMatch.score + 10_000 + index / 10_000,
          positions: new Set<number>(),
        };
      })
      .filter((value): value is MatchResult => value !== null)
      .sort((a, b) => a.score - b.score || b.item.timestamp - a.item.timestamp);
  }

  private renderTwoPane(lines: string[], innerWidth: number, side: string): void {
    const listWidth = Math.floor(innerWidth * 0.45);
    const previewWidth = innerWidth - listWidth - 1;
    const visible = visibleWindow(this.filtered.length, this.selectedIndex, MAX_VISIBLE);
    const listLines = this.renderListLines(listWidth, visible.start, visible.end);
    const previewLines = this.renderPreviewLines(previewWidth, MAX_VISIBLE);
    const rowCount = Math.max(MAX_VISIBLE, listLines.length, previewLines.length);

    for (let i = 0; i < rowCount; i++) {
      lines.push(
        side +
          padToWidth(listLines[i] || "", listWidth) +
          this.theme.border("│") +
          padToWidth(previewLines[i] || "", previewWidth) +
          side,
      );
    }
  }

  private renderSinglePane(lines: string[], innerWidth: number, side: string): void {
    const visible = visibleWindow(this.filtered.length, this.selectedIndex, MAX_VISIBLE);
    const listLines = this.renderListLines(innerWidth, visible.start, visible.end);

    if (listLines.length === 0) {
      lines.push(boxLine(this.theme.muted("  No matches"), innerWidth, side));
    } else {
      for (const line of listLines) lines.push(boxLine(line, innerWidth, side));
    }

    const selected = this.filtered[this.selectedIndex]?.item;
    if (!selected) return;

    lines.push(this.theme.border("├") + this.theme.border("─".repeat(innerWidth)) + this.theme.border("┤"));
    for (const line of this.renderPreviewLines(innerWidth, 7)) {
      lines.push(boxLine(line, innerWidth, side));
    }
  }

  private renderListLines(width: number, start: number, end: number): string[] {
    if (this.filtered.length === 0) return [this.theme.muted("  No matches")];

    const lines: string[] = [];
    for (let i = start; i < end; i++) {
      const result = this.filtered[i];
      if (!result) continue;

      const selected = i === this.selectedIndex;
      const prefix = selected ? this.theme.accent("→ ") : "  ";
      const date = this.theme.dim(`${formatDate(result.item.timestamp)} `);
      const text = highlightText(singleLine(result.item.text), result.positions, this.theme.match);
      const line = prefix + date + (selected ? this.theme.accent(text) : text);

      lines.push(truncateToWidth(line, width, "…"));
    }

    if (this.filtered.length > MAX_VISIBLE) {
      lines.push(this.theme.dim(`  (${this.selectedIndex + 1}/${this.filtered.length})`));
    }

    return lines;
  }

  private renderPreviewLines(width: number, maxLines: number): string[] {
    const selected = this.filtered[this.selectedIndex]?.item;
    if (!selected) return [this.theme.muted("  No selection")];

    const header = [
      this.theme.accent(this.theme.bold(formatFullDate(selected.timestamp))),
      this.theme.dim(shortCwd(selected.cwd)),
      selected.sessionName ? this.theme.dim(selected.sessionName) : undefined,
    ].filter((line): line is string => Boolean(line));

    const body = wrapPlain(selected.text, Math.max(10, width - 2));
    const all = [...header, "", ...body];
    const maxScroll = Math.max(0, all.length - maxLines);
    this.previewScroll = Math.min(this.previewScroll, maxScroll);

    return all.slice(this.previewScroll, this.previewScroll + maxLines).map((line) => {
      if (!line) return "";
      return truncateToWidth(` ${line}`, width, "…");
    });
  }
}

function fuzzyMatch(text: string, query: string): { score: number; positions: Set<number> } | null {
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const positions = new Set<number>();

  let last = -1;
  let score = 0;
  for (const char of needle) {
    const found = haystack.indexOf(char, last + 1);
    if (found === -1) return null;

    positions.add(found);
    const gap = found - last - 1;
    score += gap * 3;
    if (found === 0 || /[\s/_.:-]/.test(text.charAt(found - 1))) score -= 6;
    if (gap === 0) score -= 4;
    last = found;
  }

  score += Math.max(0, text.length - query.length) / 1000;
  return { score, positions };
}

function searchMetadata(item: HistoryItem): string {
  return [item.cwd, item.sessionName, item.sessionPath, formatDate(item.timestamp)]
    .filter(Boolean)
    .join(" ");
}

function highlightText(text: string, positions: Set<number>, highlight: (text: string) => string): string {
  if (positions.size === 0) return text;

  let out = "";
  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i);
    out += positions.has(i) ? highlight(char) : char;
  }
  return out;
}

function visibleWindow(total: number, selected: number, maxVisible: number): { start: number; end: number } {
  const visible = Math.min(maxVisible, total);
  const start = Math.max(0, Math.min(selected - Math.floor(visible / 2), total - visible));
  return { start, end: Math.min(total, start + visible) };
}

function boxLine(content: string, innerWidth: number, side: string): string {
  const clipped = truncateToWidth(content, innerWidth, "…");
  const padding = Math.max(0, innerWidth - visibleWidth(clipped));
  return side + clipped + " ".repeat(padding) + side;
}

function padToWidth(content: string, width: number): string {
  const clipped = truncateToWidth(content, width, "…");
  const padding = Math.max(0, width - visibleWidth(clipped));
  return clipped + " ".repeat(padding);
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function wrapPlain(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine;
    while (visibleWidth(line) > width) {
      let cut = width;
      const slice = line.slice(0, width + 1);
      const space = slice.lastIndexOf(" ");
      if (space > Math.floor(width * 0.5)) cut = space;
      lines.push(line.slice(0, cut).trimEnd());
      line = line.slice(cut).trimStart();
    }
    lines.push(line);
  }
  return lines;
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toLocaleDateString(undefined, { month: "short", day: "2-digit" });
}

function formatFullDate(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "unknown date";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function normalizeCwd(cwd: string): string {
  return cwd ? resolve(cwd) : "";
}

function shortCwd(cwd: string): string {
  const home = process.env.HOME;
  if (home && cwd.startsWith(home)) return `~${cwd.slice(home.length)}`;
  return cwd || "unknown cwd";
}
