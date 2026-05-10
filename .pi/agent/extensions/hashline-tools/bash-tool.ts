import { execFile } from "node:child_process";
import type { AgentToolResult, BashToolDetails, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool, formatSize } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const ROW_PREFIX = "    ";
const BASH_ICON = "○";
const MAX_COMMAND_CHARS = 96;
const MAX_SUMMARY_CHARS = 64;
const ERROR_SUMMARY_LEFT_PADDING = "        ";
const SUMMARY_FAILURE_LEFT_PADDING = "        ";
const COMMAND_SUMMARY_PREFIX = "[pi bash command summary]:";
const COMMAND_SUMMARY_ERROR_PREFIX = "[pi bash command summary error]:";
const ERROR_SUMMARY_PREFIX = "[pi bash error summary]:";
const ERROR_SUMMARY_ERROR_PREFIX = "[pi bash error summary error]:";

type ToolStatus = "pending" | "done" | "error";

function statusIcon(status: ToolStatus, theme: any): string {
	if (status === "pending") return theme.fg("warning", "●");
	if (status === "done") return theme.fg("success", "✓");
	return theme.fg("error", "✗");
}

function normalizeCommand(command: unknown): string {
	if (typeof command !== "string") return "<unknown>";
	return command
		.replace(/\r?\n/g, " ⏎ ")
		.replace(/\s+/g, " ")
		.trim();
}

function shorten(text: string, maxChars = MAX_COMMAND_CHARS): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function getTextOutput(result: AgentToolResult<BashToolDetails | undefined>): string {
	const content = result.content[0];
	return content?.type === "text" ? content.text : "";
}

function stripBashNotices(output: string): string {
	return output
		.replace(/\n\n\[Showing[\s\S]*$/m, "")
		.replace(/\n\nCommand exited with code \d+[\s\S]*$/m, "")
		.replace(/\n\nCommand timed out after \d+ seconds[\s\S]*$/m, "")
		.replace(/\n\nCommand aborted[\s\S]*$/m, "")
		.replace(/\n+$/g, "");
}

function countOutputLines(output: string): number {
	if (output === "" || output === "(no output)") return 0;
	return output.split("\n").length;
}

function formatOutputStats(result: AgentToolResult<BashToolDetails | undefined>, theme: any): string {
	const truncation = result.details?.truncation;
	if (truncation?.truncated) {
		const omittedLines = Math.max(0, truncation.totalLines - truncation.outputLines);
		const lineStats = `${truncation.outputLines}/${truncation.totalLines} lines`;
		const sizeStats = `${formatSize(truncation.outputBytes)}/${formatSize(truncation.totalBytes)}`;
		const omitted = omittedLines > 0 ? `, ${omittedLines} truncated` : "";
		return theme.fg("muted", ` ${lineStats}, ${sizeStats}${omitted}`);
	}

	const output = stripBashNotices(getTextOutput(result));
	const lines = countOutputLines(output);
	const size = Buffer.byteLength(output, "utf8");
	return theme.fg("muted", ` ${lines} line${lines === 1 ? "" : "s"}, ${formatSize(size)}`);
}

type SummaryResult = { summary?: string; error?: string };
type BashDetailsWithSummary = (BashToolDetails & { commandSummary?: string; commandSummaryError?: string }) | undefined;

function firstNonEmptyLine(text: unknown): string | undefined {
	if (typeof text !== "string") return undefined;
	return text.split("\n").find((line) => line.trim() !== "")?.trim();
}

function formatSummaryProcessError(error: unknown, stderr: string, stdout: string): string {
	const err = error as { code?: unknown; signal?: unknown; killed?: boolean; message?: string };
	const stderrLine = firstNonEmptyLine(stderr);
	const stdoutLine = firstNonEmptyLine(stdout);

	if (err.code === "ENOENT") return "pi executable not found";
	if (err.code === "ETIMEDOUT") return "timed out after 10s";
	if (err.killed && err.signal === "SIGTERM") return "timed out after 10s or was killed";
	if (typeof err.code === "number") return `pi exited with code ${err.code}${stderrLine ? `: ${shorten(stderrLine, 160)}` : ""}`;
	if (stderrLine) return `pi failed: ${shorten(stderrLine, 160)}`;
	if (stdoutLine) return `pi failed: ${shorten(stdoutLine, 160)}`;
	if (err.message) return shorten(err.message.replace(/\s+/g, " "), 160);
	return "unknown failure";
}

const SHELL_SETUP_COMMANDS = new Set(["cd", "set", "export", "source", "."]);
const SHELL_WRAPPER_COMMANDS = new Set(["time", "command", "builtin", "exec", "env", "sudo", "doas", "runuser", "nohup", "nice", "ionice", "timeout"]);
const WRAPPER_OPTIONS_WITH_VALUES: Record<string, Set<string>> = {
  doas: new Set(["-u", "--user"]),
  env: new Set(["-C", "--chdir", "-S", "--split-string", "-u", "--unset"]),
  ionice: new Set(["-c", "--class", "-n", "--classdata", "-p", "--pid", "-P", "--pgid", "-u", "--uid"]),
  nice: new Set(["-n", "--adjustment"]),
  runuser: new Set(["-c", "--command", "-g", "--group", "-G", "--supp-group", "-s", "--shell", "-u", "--user"]),
  sudo: new Set(["-C", "--close-from", "-D", "--chdir", "-g", "--group", "-h", "--host", "-p", "--prompt", "-u", "--user"]),
  time: new Set(["-f", "--format", "-o", "--output"]),
  timeout: new Set(["-k", "--kill-after", "-s", "--signal"]),
};

function splitShellTokens(segment: string): string[] {
  return segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

function cleanShellToken(token: string): string {
  return token
    .trim()
    .replace(/^[([{]+/g, "")
    .replace(/[)\]}]+$/g, "")
    .replace(/^['"]|['"]$/g, "")
    .replace(/^[<>|&;]+/g, "")
    .replace(/[<>|&;]+$/g, "");
}

function isShellAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function isShellRedirection(token: string): boolean {
  return /^(?:\d*)[<>]/.test(token);
}

function normalizeToolName(token: string): string | undefined {
  const base = token.split(/[\\/]/).filter(Boolean).pop() ?? token;
  const cleaned = base.replace(/[^A-Za-z0-9_.+-].*$/g, "").trim();
  if (!cleaned) return undefined;
  if (/^python\d+(?:\.\d+)?$/i.test(cleaned)) return "python";
  if (/^pip\d+(?:\.\d+)?$/i.test(cleaned)) return "pip";
  if (/^nodejs$/i.test(cleaned)) return "node";
  return cleaned;
}

function wrapperOptionTakesValue(wrapper: string, option: string): boolean {
  return WRAPPER_OPTIONS_WITH_VALUES[wrapper]?.has(option) ?? false;
}

function skipWrapperTokens(tokens: string[], wrapperIndex: number, wrapper: string): number {
  let index = wrapperIndex + 1;
  while (index < tokens.length) {
    const token = cleanShellToken(tokens[index]);
    if (!token || isShellAssignment(token)) {
      index += 1;
      continue;
    }
    if (token === "--") {
      index += 1;
      break;
    }
    if (token.startsWith("-")) {
      const option = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
      index += 1;
      if (!token.includes("=") && wrapperOptionTakesValue(wrapper, option) && index < tokens.length) index += 1;
      continue;
    }
    if (wrapper === "timeout" && /^\d+(?:\.\d+)?[smhd]?$/i.test(token)) {
      index += 1;
      continue;
    }
    if ((wrapper === "nice" || wrapper === "ionice") && /^-?\d+$/.test(token)) {
      index += 1;
      continue;
    }
    break;
  }
  return index - 1;
}

function extractCommandTool(segment: string): string | undefined {
  const tokens = splitShellTokens(segment);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = cleanShellToken(tokens[index]);
    if (!token || token.startsWith("#") || isShellAssignment(token) || isShellRedirection(token)) continue;

    const tool = normalizeToolName(token);
    if (!tool) continue;
    const toolKey = tool.toLowerCase();
    if (SHELL_WRAPPER_COMMANDS.has(toolKey)) {
      index = skipWrapperTokens(tokens, index, toolKey);
      continue;
    }
    return tool;
  }
  return undefined;
}

function inferCommandTool(command: unknown): string | undefined {
  if (typeof command !== "string") return undefined;
  const segments = command
    .replace(/\\\r?\n/g, " ")
    .split(/\s*(?:&&|\|\||;|\r?\n)\s*/g)
    .filter((segment) => segment.trim() !== "");

  for (let index = 0; index < segments.length; index += 1) {
    const tool = extractCommandTool(segments[index]);
    if (!tool) continue;
    if (SHELL_SETUP_COMMANDS.has(tool.toLowerCase()) && index < segments.length - 1) continue;
    return tool;
  }
  return undefined;
}

function stripExistingToolPrefix(summary: string): string {
  return summary.replace(/^[A-Za-z][A-Za-z0-9_.+-]{0,31}:\s*/, "");
}

function prefixCommandSummary(summary: string, command: unknown): string {
  const tool = inferCommandTool(command);
  if (!tool) return shorten(summary, MAX_SUMMARY_CHARS);
  if (summary.toLowerCase().startsWith(`${tool.toLowerCase()}:`)) return shorten(summary, MAX_SUMMARY_CHARS);
  return shorten(`${tool}: ${stripExistingToolPrefix(summary)}`, MAX_SUMMARY_CHARS);
}

function fallbackCommandSummary(command: unknown): string | undefined {
  const fallback = normalizeCommand(command);
  if (!fallback || fallback === "<unknown>") return fallback;
  const tool = inferCommandTool(command);
  return shorten(tool ? `${tool}: ${fallback}` : fallback, MAX_SUMMARY_CHARS);
}

function summarizeOneSentence(text: unknown, signal?: AbortSignal, options?: { command?: unknown }): Promise<SummaryResult> {
  if (typeof text !== "string" || text.trim() === "") return Promise.resolve({});

  const command = options?.command;
  const commandTool = command === undefined ? undefined : inferCommandTool(command);
  const prompt =
    command === undefined
      ? `Summarize this bash error or output in ${MAX_SUMMARY_CHARS} characters or fewer. Use plain text, no markdown, no backticks, no period. Text: ${text}`
      : `Summarize this shell command in ${MAX_SUMMARY_CHARS} characters or fewer. Prefix the summary with the executable or shell tool used followed by a colon and a space${commandTool ? `; use "${commandTool}: " as the prefix` : ""}. Examples: "grep: searching for x or y", "python: running x and y". Use plain text, no markdown, no backticks, no period. Command: ${text}`;

  return new Promise((resolve) => {
    const child = execFile(
      "pi",
      [
        "--model",
        "openai-codex/gpt-5.4-mini",
        "--thinking",
        "off",
        "--no-tools",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--no-session",
        "--offline",
        "-p",
        prompt,
      ],
      { timeout: 10_000, maxBuffer: 16 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ error: formatSummaryProcessError(error, stderr, stdout) });
          return;
        }

        let summary = stdout.replace(/[`*_#]/g, "").replace(/\s+/g, " ").trim().replace(/[.。]+$/g, "");
        if (summary && command !== undefined) summary = prefixCommandSummary(summary, command);
        resolve(summary ? { summary: shorten(summary, MAX_SUMMARY_CHARS) } : { error: "pi produced no summary output" });
      },
    );
    child.stdin?.end();

    const abort = () => {
      child.kill();
      resolve({ error: "aborted" });
    };

    if (signal?.aborted) {
      abort();
      return;
    }

    signal?.addEventListener("abort", abort, { once: true });
    child.once("exit", () => signal?.removeEventListener("abort", abort));
  });
}

function attachCommandSummary(
  result: AgentToolResult<BashToolDetails | undefined>,
  summary: SummaryResult,
  command: unknown,
  fallbackToCommand: boolean,
 ): AgentToolResult<BashDetailsWithSummary> {
  const commandSummary = summary.summary ?? (fallbackToCommand ? fallbackCommandSummary(command) : undefined);
  return {
    ...result,
    details: { ...((result.details ?? {}) as BashToolDetails), commandSummary, commandSummaryError: summary.error },
  } as AgentToolResult<BashDetailsWithSummary>;
}

function appendBashSummariesToError(message: string, command: unknown, commandSummary: SummaryResult, errorSummary: SummaryResult): string {
  const summaries: string[] = [];
  const commandSummaryText = commandSummary.summary ?? fallbackCommandSummary(command);
  if (commandSummaryText) summaries.push(`${COMMAND_SUMMARY_PREFIX} ${commandSummaryText}`);
  if (commandSummary.error) summaries.push(`${COMMAND_SUMMARY_ERROR_PREFIX} ${commandSummary.error}`);
  if (errorSummary.summary) summaries.push(`${ERROR_SUMMARY_PREFIX} ${errorSummary.summary}`);
  if (errorSummary.error) summaries.push(`${ERROR_SUMMARY_ERROR_PREFIX} ${errorSummary.error}`);
  return summaries.length > 0 ? `${message}\n\n${summaries.join("\n")}` : message;
}

function extractPrefixedLine(output: string, prefix: string): string | undefined {
	const line = output.split("\n").find((candidate) => candidate.startsWith(prefix));
	return line?.slice(prefix.length).trim() || undefined;
}

function formatErrorSummary(summary: string | undefined, theme: any): string {
	return summary ? `\n${ERROR_SUMMARY_LEFT_PADDING}${theme.fg("error", summary)}` : "";
}

function formatSummaryFailure(label: string, summaryError: string | undefined, theme: any): string {
	return summaryError ? `\n${SUMMARY_FAILURE_LEFT_PADDING}${theme.fg("warning", `${label} failed: ${summaryError}`)}` : "";
}

function formatBashRow(
	status: ToolStatus,
	args: unknown,
	theme: any,
	stats = "",
	message?: string,
	commandSummary?: string,
	maxWidth?: number,
 ): string {
	const fallbackCommand = normalizeCommand((args as any)?.command);
	const fallback = status === "pending" ? "summarizing command…" : fallbackCommand === "<unknown>" ? "command summary unavailable" : fallbackCommand;
	const rawCommand = commandSummary ?? fallback;
	const prefix = `${ROW_PREFIX}${statusIcon(status, theme)} ${theme.fg("toolTitle", BASH_ICON)} `;
	let suffix = stats;
	if (typeof (args as any)?.timeout === "number") suffix += theme.fg("muted", ` timeout=${(args as any).timeout}s`);
	if (message) suffix += ` ${theme.fg(status === "error" ? "error" : "muted", message)}`;

	const availableCommandWidth =
		typeof maxWidth === "number" ? Math.max(1, maxWidth - visibleWidth(prefix) - visibleWidth(suffix)) : MAX_COMMAND_CHARS;
	const command = truncateToWidth(rawCommand, Math.min(MAX_COMMAND_CHARS, availableCommandWidth), "…");
	return `${prefix}${theme.fg("accent", command)}${suffix}`;
}

function renderToolText(renderText: (width: number) => string): any {
	return {
		invalidate() {},
		render(width: number): string[] {
			const maxWidth = Math.max(1, width);
			return renderText(maxWidth)
				.split("\n")
				.map((line) => truncateToWidth(line, maxWidth, "…"));
		},
	};
}

function emptyToolRow(): Text {
	return new Text("", 0, 0);
}

function firstTextLine(result: AgentToolResult<BashToolDetails | undefined>): string | undefined {
	const output = stripBashNotices(getTextOutput(result));
	return output.split("\n").find((line) => line.trim() !== "");
}

export function registerBashTool(pi: ExtensionAPI): void {
	const metadataBash = createBashTool(process.cwd());

	pi.registerTool({
		name: "bash",
		label: "bash",
		description: metadataBash.description,
		promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
		parameters: metadataBash.parameters,
		renderShell: "self",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const bash = createBashTool(ctx.cwd);
      const command = (params as any)?.command;
      let latestUpdate: AgentToolResult<BashToolDetails | undefined> | undefined;
      let latestCommandSummary: SummaryResult | undefined;

      const emitUpdate = (update: AgentToolResult<BashToolDetails | undefined>, fallbackToCommand = false) => {
        onUpdate?.(attachCommandSummary(update, latestCommandSummary ?? {}, command, fallbackToCommand));
      };

      const emitSummaryUpdate = () => {
        if (!onUpdate || !latestCommandSummary || (!latestCommandSummary.summary && !latestCommandSummary.error)) return;
        emitUpdate(latestUpdate ?? { content: [], details: undefined }, false);
      };

      const fallbackSummary = fallbackCommandSummary(command);
      if (fallbackSummary) {
        latestCommandSummary = { summary: fallbackSummary };
        emitSummaryUpdate();
      }

      const commandSummaryPromise = summarizeOneSentence(command, signal, { command }).then((summary) => {
        latestCommandSummary = summary.summary ? summary : { ...summary, summary: fallbackSummary };
        emitSummaryUpdate();
        return latestCommandSummary;
      });

      const wrappedOnUpdate = onUpdate
        ? (update: AgentToolResult<BashToolDetails | undefined>) => {
            latestUpdate = update;
            emitUpdate(update);
          }
        : undefined;

      try {
        const bashResult = await (bash.execute as any)(toolCallId, params, signal, wrappedOnUpdate, ctx);
        const commandSummary = await commandSummaryPromise;
        return attachCommandSummary(bashResult, commandSummary, command, true);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const [commandSummary, errorSummary] = await Promise.all([commandSummaryPromise, summarizeOneSentence(message, signal)]);
        throw new Error(appendBashSummariesToError(message, command, commandSummary, errorSummary));
      }
		},
		renderCall(args, theme, context) {
			if (context.executionStarted || !context.isPartial) return emptyToolRow();
			return renderToolText((width) => formatBashRow("pending", args, theme, "", undefined, undefined, width));
		},
    renderResult(result, { isPartial }, theme, context) {
      const typedResult = result as AgentToolResult<BashDetailsWithSummary>;
      const rawOutput = getTextOutput(result as AgentToolResult<BashToolDetails | undefined>);
      const showStats = !isPartial || rawOutput !== "" || Boolean(typedResult.details?.truncation?.truncated);
      const stats = showStats ? formatOutputStats(typedResult as AgentToolResult<BashToolDetails | undefined>, theme) : "";
      const commandSummary = typedResult.details?.commandSummary ?? extractPrefixedLine(rawOutput, COMMAND_SUMMARY_PREFIX);
      const commandSummaryError = typedResult.details?.commandSummaryError ?? extractPrefixedLine(rawOutput, COMMAND_SUMMARY_ERROR_PREFIX);
      const errorSummary = extractPrefixedLine(rawOutput, ERROR_SUMMARY_PREFIX);
      const errorSummaryError = extractPrefixedLine(rawOutput, ERROR_SUMMARY_ERROR_PREFIX);

      if (isPartial) {
        return renderToolText(
          (width) =>
            formatBashRow("pending", context.args, theme, stats, undefined, commandSummary, width) +
            formatSummaryFailure("pi command summary", commandSummaryError, theme),
        );
      }

      if (context.isError) {
        return renderToolText(
          (width) =>
            formatBashRow(
              "error",
              context.args,
              theme,
              stats,
              firstTextLine(result as AgentToolResult<BashToolDetails | undefined>),
              commandSummary,
              width,
            ) +
            formatErrorSummary(errorSummary, theme) +
            formatSummaryFailure("pi command summary", commandSummaryError, theme) +
            formatSummaryFailure("pi error summary", errorSummaryError, theme),
        );
      }

      return renderToolText(
        (width) =>
          formatBashRow("done", context.args, theme, stats, undefined, commandSummary, width) +
          formatSummaryFailure("pi command summary", commandSummaryError, theme),
      );
		},
	});
}
