/**
 * Claude Commands Extension for pi
 *
 * Loads Claude Code slash commands from `.claude/commands/` (project-local)
 * and `~/.claude/commands/` (personal) and registers them as pi commands
 * so they appear in the `/` autocomplete suggestion list.
 *
 * Supported features:
 * - YAML frontmatter (description, argument-hint)
 * - Argument expansion ($ARGUMENTS, $@, $1, $2, ${@:N}, ${@:N:L})
 * - Bash execution via !`command` syntax
 * - File references via @filename syntax
 * - Subdirectories (deploy/prod.md → /claude:deploy/prod)
 * - Project commands override personal commands with the same name
 *
 * Commands are registered with a "claude:" prefix to avoid conflicts with
 * built-in pi commands and other extensions. Type `/claude:review`, etc.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ClaudeCommand {
  /** Command name (relative path without .md, e.g. "deploy/prod") */
  name: string;
  /** One-line description from frontmatter */
  description: string;
  /** Argument hint shown in listings */
  argumentHint?: string;
  /** Template body (after frontmatter) */
  content: string;
  /** Where the command was loaded from */
  source: "project" | "personal";
  /** Absolute path to the .md file */
  filePath: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal YAML-like frontmatter parser.
 * Handles `key: value` lines inside a `---` block.
 */
function parseFrontmatter(
  raw: string
): { frontmatter: Record<string, string>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: raw };

  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (key && value) frontmatter[key] = value;
    }
  }
  return { frontmatter, body: match[2] };
}

/**
 * Recursively find `.md` files in a directory.
 * Returns entries with relative path (without .md) and absolute file path.
 */
function findCommandFiles(
  dir: string,
  prefix = ""
): Array<{ name: string; fullPath: string }> {
  const results: Array<{ name: string; fullPath: string }> = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(
        ...findCommandFiles(path.join(dir, entry.name), relative)
      );
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const name = relative.replace(/\.md$/, "");
      results.push({ name, fullPath: path.join(dir, entry.name) });
    }
  }
  return results;
}

/**
 * Shell-style argument splitter that respects single and double quotes.
 */
function parseArgs(args: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuote = false;
  let quoteChar = "";

  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (inQuote) {
      if (ch === quoteChar) {
        inQuote = false;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
    } else if (ch === " " || ch === "\t") {
      if (current) {
        parts.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * Expand template variables in the command body.
 *
 * Supports:
 *   $ARGUMENTS  – all args as a single string
 *   $@          – all args joined with spaces
 *   $1, $2 …   – positional argument
 *   ${@:N}      – args from position N (1-indexed)
 *   ${@:N:L}    – L args starting at position N
 */
function expandArguments(template: string, args: string): string {
  const parts = parseArgs(args);
  let result = template;

  // $ARGUMENTS
  result = result.replace(/\$ARGUMENTS/g, args);
  // $@
  result = result.replace(/\$@/g, args);
  // ${@:N} and ${@:N:L}
  result = result.replace(
    /\$\{@:(\d+)(?::(\d+))?\}/g,
    (_, startStr, lenStr) => {
      const start = parseInt(startStr, 10) - 1;
      const len = lenStr ? parseInt(lenStr, 10) : undefined;
      return len !== undefined
        ? parts.slice(start, start + len).join(" ")
        : parts.slice(start).join(" ");
    }
  );
  // $1, $2, …
  result = result.replace(/\$(\d+)/g, (_, num) => {
    const idx = parseInt(num, 10) - 1;
    return idx >= 0 && idx < parts.length ? parts[idx] : "";
  });

  return result;
}

/**
 * Execute inline bash commands marked with !`command`.
 * Each occurrence is replaced with the command's stdout.
 */
async function expandBashCommands(
  template: string,
  exec: ExtensionAPI["exec"],
  signal?: AbortSignal
): Promise<string> {
  const pattern = /!\`([^\`]+)\`/g;
  const matches = [...template.matchAll(pattern)];

  if (matches.length === 0) return template;

  let result = template;
  for (const m of matches) {
    try {
      const res = await exec("bash", ["-c", m[1]], { signal });
      const output = res.stdout.trim();
      result = result.replace(m[0], output);
    } catch (err: any) {
      result = result.replace(
        m[0],
        `[Error: ${err.message ?? err}]`
      );
    }
  }
  return result;
}

/**
 * Expand @filename references by reading the file content.
 * Paths are resolved relative to `cwd`.
 * Skips things that look like email addresses.
 */
function expandFileReferences(template: string, cwd: string): string {
  return template.replace(/@(\S+)/g, (match, rawPath) => {
    if (rawPath.includes("@")) return match;

    const absPath = path.resolve(cwd, rawPath);
    try {
      if (fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
        return fs.readFileSync(absPath, "utf-8");
      }
      return `[File not found: ${rawPath}]`;
    } catch (err: any) {
      return `[Error reading ${rawPath}: ${err.message ?? err}]`;
    }
  });
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const COMMAND_PREFIX = "claude:";

export default function claudeCommandsExtension(pi: ExtensionAPI) {
  const commands = new Map<string, ClaudeCommand>();

  // ---- Loading (called at load time AND on session events) ---------------

  function loadCommands(cwd: string): void {
    commands.clear();

    const homeDir = path.join(
      process.env.HOME ?? process.env.USERPROFILE ?? "",
      ".claude",
      "commands"
    );

    // Personal commands first (lower priority)
    for (const { name, fullPath } of findCommandFiles(homeDir)) {
      addCommand(name, fullPath, "personal");
    }

    // Project commands override personal ones
    const projectDir = path.join(cwd, ".claude", "commands");
    for (const { name, fullPath } of findCommandFiles(projectDir)) {
      addCommand(name, fullPath, "project");
    }
  }

  function addCommand(
    name: string,
    fullPath: string,
    source: "project" | "personal"
  ): void {
    const raw = fs.readFileSync(fullPath, "utf-8");
    const { frontmatter, body } = parseFrontmatter(raw);
    const description =
      frontmatter["description"] ??
      body.split(/\r?\n/).find((l) => l.trim()) ??
      "";
    const argumentHint = frontmatter["argument-hint"];

    commands.set(name, {
      name,
      description,
      argumentHint,
      content: body.trim(),
      source,
      filePath: fullPath,
    });
  }

  // ---- Register commands at load time for autocomplete -------------------
  // process.cwd() is the project directory when extensions are loaded.
  // We register each Claude command with a "claude:" prefix so they show
  // up in the / autocomplete suggestion list and don't conflict with
  // built-in pi commands or other extensions.
  //
  // Handlers read from the live `commands` Map (not a closure) so they
  // stay in sync after session switches that call loadCommands().

  loadCommands(process.cwd());

  for (const [name, cmd] of commands) {
    const registerName = `${COMMAND_PREFIX}${name}`;
    const desc = cmd.argumentHint
      ? `${cmd.description} <${cmd.argumentHint}>`
      : cmd.description;

    pi.registerCommand(registerName, {
      description: desc,
      getArgumentCompletions: (prefix: string) => {
        // If the command has no argument hint, don't offer completions
        if (!cmd.argumentHint) return null;
        return [{ value: prefix, label: cmd.argumentHint }];
      },
      handler: async (args, ctx) => {
        // Read the *current* command content (may differ after session switch)
        const current = commands.get(name);
        if (!current) {
          ctx.ui.notify(
            `Claude command /${registerName} not found in this project`,
            "warning"
          );
          return;
        }

        // 1. Expand argument variables
        let expanded = expandArguments(current.content, args);

        // 2. Execute inline bash commands
        expanded = await expandBashCommands(
          expanded,
          pi.exec.bind(pi),
          ctx.signal
        );

        // 3. Resolve @file references
        expanded = expandFileReferences(expanded, ctx.cwd);

        // 4. Send as a user message to the agent
        pi.sendUserMessage(expanded);
      },
    });
  }

  // ---- Refresh on session switch ------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    loadCommands(ctx.cwd);
    const count = commands.size;
    if (count > 0) {
      const names = [...commands.keys()]
        .map((n) => `/${COMMAND_PREFIX}${n}`)
        .join(", ");
      ctx.ui.notify(`Claude commands: ${count} loaded – ${names}`, "info");
    }
  });

  pi.on("session_switch", async (_event, ctx) => {
    loadCommands(ctx.cwd);
  });
}
