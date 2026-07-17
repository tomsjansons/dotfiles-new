import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { MutableJobRecord } from "./types.ts";

export const MAX_OUTPUT_LINES = 2_000;
export const MAX_OUTPUT_BYTES = 50 * 1024;
const TRUNCATION_MARKER = "[truncated]";

export interface TruncatedOutput {
  text: string;
  truncated: boolean;
  totalLines: number;
  totalBytes: number;
}

export function safeTimestamp(value = new Date().toISOString()): string {
  return value.replaceAll(":", "-").replaceAll(".", "-");
}

export function cwdSlug(cwd: string): string {
  if (cwd === "/") return "--root--";
  return `--${cwd.replace(/^\/+/, "").replaceAll("/", "-")}--`;
}

export function jobArtifactDir(input: {
  cwd: string;
  sessionId: string;
  sessionTimestamp: string;
  jobId: string;
  jobTimestamp: string;
}): string {
  const sessionPart = `${safeTimestamp(input.sessionTimestamp)}-${input.sessionId}`;
  const jobPart = `${safeTimestamp(input.jobTimestamp)}-${input.jobId}`;
  return join(homedir(), ".pi", "pi-execute", cwdSlug(input.cwd), sessionPart, jobPart);
}

export async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

export async function appendEvent(artifactDir: string, event: Record<string, unknown>): Promise<void> {
  await mkdir(artifactDir, { recursive: true });
  await appendFile(join(artifactDir, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
}

export function publicRecord(record: MutableJobRecord): Record<string, unknown> {
  return {
    id: record.id,
    type: record.type,
    mode: record.mode,
    status: record.status,
    cwd: record.cwd,
    sessionId: record.sessionId,
    sessionPath: record.sessionPath,
    parentJobId: record.parentJobId,
    rootJobId: record.rootJobId,
    artifactDir: record.artifactDir,
    outputPath: record.outputPath,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    durationMs: record.durationMs,
    exitCode: record.exitCode,
    signal: record.signal,
    error: record.error,
    stopReason: record.stopReason,
    deliveryState: record.deliveryState,
  };
}

export async function persistManifest(record: MutableJobRecord): Promise<void> {
  await atomicWrite(join(record.artifactDir, "manifest.json"), `${JSON.stringify(publicRecord(record), null, 2)}\n`);
}

export async function persistResult(record: MutableJobRecord): Promise<void> {
  await atomicWrite(join(record.artifactDir, "result.json"), `${JSON.stringify(publicRecord(record), null, 2)}\n`);
}

function utf8Head(value: string, budget: number): string {
  if (Buffer.byteLength(value) <= budget) return value;
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (bytes + size > budget) break;
    result += character;
    bytes += size;
  }
  return result;
}

function utf8Tail(value: string, budget: number): string {
  if (Buffer.byteLength(value) <= budget) return value;
  const characters = [...value];
  let bytes = 0;
  let result = "";
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index]!;
    const size = Buffer.byteLength(character);
    if (bytes + size > budget) break;
    result = character + result;
    bytes += size;
  }
  return result;
}

export function truncateMiddle(value: string): TruncatedOutput {
  const totalBytes = Buffer.byteLength(value, "utf8");
  const lines = value === "" ? [] : value.split("\n");
  const totalLines = lines.length;
  if (totalLines <= MAX_OUTPUT_LINES && totalBytes <= MAX_OUTPUT_BYTES) {
    return { text: value, truncated: false, totalLines, totalBytes };
  }

  const headLineCount = Math.floor((MAX_OUTPUT_LINES - 1) / 2);
  const tailLineCount = MAX_OUTPUT_LINES - 1 - headLineCount;
  let head = lines.slice(0, headLineCount).join("\n");
  let tail = lines.slice(Math.max(headLineCount, lines.length - tailLineCount)).join("\n");

  const marker = `\n${TRUNCATION_MARKER}\n`;
  const availableBytes = Math.max(0, MAX_OUTPUT_BYTES - Buffer.byteLength(marker));
  const headBytes = Math.floor(availableBytes / 2);
  const tailBytes = availableBytes - headBytes;
  head = utf8Head(head || value, headBytes);
  tail = utf8Tail(tail || value, tailBytes);

  return {
    text: `${head}${marker}${tail}`,
    truncated: true,
    totalLines,
    totalBytes,
  };
}
