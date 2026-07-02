import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CURSOR_MARKER, matchesKey, type Component, type Focusable } from "@earendil-works/pi-tui";

const DEFAULT_TIMEOUT_MS = 120_000;
const PREVIEW_LINES = 20;
const PREVIEW_BYTES = 4_000;
const SUDO_PROMPT_TOKEN = "__PI_EXECUTE_SSH_SUDO_PASSWORD__";
const MAX_SUDO_PASSWORD_SENDS = 10;

const executeSshSchema = Type.Object({
	server: Type.String({
		description: "SSH target, for example user@example.com or an SSH config host alias.",
	}),
	command: Type.String({
		description: "Command to execute on the remote machine.",
	}),
	timeoutMs: Type.Optional(
		Type.Number({
			description: "Optional timeout in milliseconds. Defaults to 120000.",
			minimum: 1,
		}),
	),
});

type ExecuteSshParams = {
	server: string;
	command: string;
	timeoutMs?: number;
};

type SshResult = {
	stdout: string;
	stderr: string;
	code: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
};

type OutputFiles = {
	dir: string;
	stdoutPath: string;
	stderrPath: string;
	combinedPath: string;
	stdoutBytes: number;
	stderrBytes: number;
	combinedBytes: number;
	stdoutLines: number;
	stderrLines: number;
	combinedLines: number;
};

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "execute_ssh",
		label: "Execute SSH",
		description:
			"Execute a command on a remote machine over SSH. For remote sudo commands, Pi prompts for the remote sudo password and feeds it to sudo over stdin.",
		parameters: executeSshSchema,

		async execute(_toolCallId, params: ExecuteSshParams, signal, _onUpdate, ctx) {
			const server = params.server.trim();
			const command = params.command.trim();

			if (!server) {
				return textResult("Missing SSH server.", true, {});
			}
			if (!command) {
				return textResult("Missing remote command.", true, {});
			}

			const sudo = isSudoCommand(command);
			let sudoPassword: string | undefined;

			if (sudo) {
				if (!ctx.hasUI) {
					return textResult("Remote sudo password is required, but Pi UI is unavailable.", true, {
						server,
						command,
					});
				}

				sudoPassword = await promptSudoPassword(ctx, server, command);

				if (!sudoPassword) {
					return textResult("Cancelled: no remote sudo password provided.", true, { server, command });
				}
			}

			try {
				const executedCommand = sudo ? buildSudoCommand(command) : command;
				const result = await runSsh({
					server,
					command: executedCommand,
					sudoPassword,
					timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
					signal,
				});
				result.stdout = stripTerminalControls(result.stdout);
				result.stderr = stripSshSessionNoise(stripTerminalControls(result.stderr));
				if (sudoPassword) {
					result.stdout = redactSecret(result.stdout, sudoPassword);
					result.stderr = redactSecret(result.stderr, sudoPassword);
				}

				const outputFiles = await writeOutputFiles(server, command, executedCommand, result);
				const text = formatResult(command, result, outputFiles);
				return {
					isError: result.code !== 0 || result.timedOut,
					content: [{ type: "text" as const, text }],
					details: {
						server,
						command,
						executedCommand,
						stdoutPath: outputFiles.stdoutPath,
						stderrPath: outputFiles.stderrPath,
						combinedPath: outputFiles.combinedPath,
						stdoutBytes: outputFiles.stdoutBytes,
						stderrBytes: outputFiles.stderrBytes,
						combinedBytes: outputFiles.combinedBytes,
						stdoutLines: outputFiles.stdoutLines,
						stderrLines: outputFiles.stderrLines,
						combinedLines: outputFiles.combinedLines,
						code: result.code,
						signal: result.signal,
						timedOut: result.timedOut,
					},
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textResult(`SSH execution failed: ${message}`, true, { server, command });
			}
		},
	});
}

async function promptSudoPassword(
	ctx: {
		mode: string;
		ui: {
			input: (title: string, placeholder?: string) => Promise<string | undefined>;
			custom?: <T>(
				factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: T) => void) => Component,
				options?: Record<string, unknown>,
			) => Promise<T>;
		};
	},
	server: string,
	command: string,
): Promise<string | undefined> {
	const title = "Remote sudo password required";
	const message = `Server: ${server}`;
	if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") {
		return ctx.ui.input(
			title,
			`${message}\nCommand:\n${command}\n\nPassword is sent to remote sudo and is not returned to the model.`,
		);
	}

	return ctx.ui.custom<string | undefined>(
		(_tui, _theme, _keybindings, done) => new PasswordInputDialog(title, message, command, done),
		{ overlay: true, overlayOptions: { width: "90%", maxHeight: "80%" } },
	);
}

class PasswordInputDialog implements Component, Focusable {
	focused = false;
	private value = "";
	private scrollOffset = 0;
	private completed = false;

	constructor(
		private readonly title: string,
		private readonly message: string,
		private readonly command: string,
		private readonly done: (value: string | undefined) => void,
	) {}

	render(width: number): string[] {
		const innerWidth = Math.max(30, Math.min(width - 4, 110));
		const border = `+${"-".repeat(innerWidth + 2)}+`;
		const masked = "*".repeat(this.value.length);
		const input = `${masked}${this.focused ? CURSOR_MARKER : ""}`;
		const commandLines = this.command.split("\n");
		const visibleCommandLines = 12;
		const maxOffset = Math.max(0, commandLines.length - visibleCommandLines);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
		const commandWindow = commandLines.slice(this.scrollOffset, this.scrollOffset + visibleCommandLines);
		const scrollHint = commandLines.length > visibleCommandLines
			? `Command (${this.scrollOffset + 1}-${Math.min(this.scrollOffset + visibleCommandLines, commandLines.length)} of ${commandLines.length}; Up/Down scroll)`
			: `Command (${commandLines.length} line${commandLines.length === 1 ? "" : "s"})`;

		return [
			border,
			this.boxLine(this.title, innerWidth),
			this.boxLine("", innerWidth),
			...this.message.split("\n").map((line) => this.boxLine(line, innerWidth)),
			this.boxLine(scrollHint, innerWidth),
			...commandWindow.map((line) => this.boxLine(`  ${line}`, innerWidth)),
			this.boxLine("", innerWidth),
			this.boxLine(`Password: ${input}`, innerWidth),
			this.boxLine("", innerWidth),
			this.boxLine("Enter: submit   Esc/Ctrl-C: cancel   Up/Down: scroll command", innerWidth),
			border,
		];
	}

	handleInput(data: string): void {
		if (this.completed) return;

		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.cancel();
			return;
		}

		if (matchesKey(data, "up")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			return;
		}
		if (matchesKey(data, "down")) {
			this.scrollOffset += 1;
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			this.submit();
			return;
		}
		if (matchesKey(data, "backspace") || matchesKey(data, "delete")) {
			this.value = this.value.slice(0, -1);
			return;
		}

		// Ignore other control/escape sequences so arrow keys, modifiers, etc. never become part of the password.
		if (data.startsWith("\x1b") || data < " ") return;

		this.value += data;
	}

	invalidate(): void {}

	private submit(): void {
		this.completed = true;
		this.done(this.value);
	}

	private cancel(): void {
		this.completed = true;
		this.done(undefined);
	}

	private boxLine(text: string, width: number): string {
		const clean = text.replace(/[\r\n]/g, " ");
		const clipped = clean.length > width ? `${clean.slice(0, Math.max(0, width - 1))}…` : clean;
		return `| ${clipped.padEnd(width)} |`;
	}
}

function isSudoCommand(command: string): boolean {
	return /(^|\n)\s*sudo(?:\s|$)/.test(command);
}

function buildSudoCommand(command: string): string {
	return command.replace(/(^|\n)([ \t]*)sudo\b/g, (_match, lineStart: string, indent: string) =>
		`${lineStart}${indent}sudo -S -p ${shellQuote(SUDO_PROMPT_TOKEN)}`,
	);
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function countOccurrences(text: string, needle: string): number {
	if (!needle) return 0;
	return text.split(needle).length - 1;
}

function redactSecret(text: string, secret: string): string {
	if (!secret) return text;
	return text.split(secret).join("[redacted sudo password]");
}

function stripTerminalControls(text: string): string {
	return text
		.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function stripSshSessionNoise(text: string): string {
	return text
		.split(/\r?\n/)
		.filter((line) => !/^Connection to .+ closed\.?$/.test(line.trim()))
		.join("\n");
}

function runSsh(options: {
	server: string;
	command: string;
	sudoPassword?: string;
	timeoutMs: number;
	signal?: AbortSignal;
}): Promise<SshResult> {
	return new Promise((resolve, reject) => {
		const args = options.sudoPassword ? ["-tt", "-o", "BatchMode=yes", options.server, options.command] : [options.server, options.command];
		const child = spawn("ssh", args, {
			stdio: ["pipe", "pipe", "pipe"],
			signal: options.signal,
		});

		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => {
				if (!settled) child.kill("SIGKILL");
			}, 2_000).unref();
		}, options.timeoutMs);
		timer.unref();

		let passwordSendCount = 0;
		const sendPasswordIfPrompted = () => {
			const stdoutPromptCount = countOccurrences(stdout, SUDO_PROMPT_TOKEN);
			const stderrPromptCount = countOccurrences(stderr, SUDO_PROMPT_TOKEN);
			const promptCount = stdoutPromptCount + stderrPromptCount;
			if (promptCount === 0) return;

			stdout = stdout.split(SUDO_PROMPT_TOKEN).join("");
			stderr = stderr.split(SUDO_PROMPT_TOKEN).join("");

			if (!options.sudoPassword) return;
			for (let i = 0; i < promptCount; i++) {
				if (passwordSendCount >= MAX_SUDO_PASSWORD_SENDS) {
					stderr += `\nexecute_ssh: exceeded ${MAX_SUDO_PASSWORD_SENDS} sudo password prompts; stopping password responses\n`;
					child.stdin.end();
					return;
				}
				passwordSendCount += 1;
				child.stdin.write(`${options.sudoPassword}\n`);
			}
		};

		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
			sendPasswordIfPrompted();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
			sendPasswordIfPrompted();
		});

		child.on("error", (error) => {
			clearTimeout(timer);
			if (!settled) {
				settled = true;
				reject(error);
			}
		});

		child.on("close", (code, closeSignal) => {
			clearTimeout(timer);
			if (!settled) {
				settled = true;
				resolve({ stdout, stderr, code, signal: closeSignal, timedOut });
			}
		});

		if (!options.sudoPassword) {
			child.stdin.end();
		}
	});
}

async function writeOutputFiles(server: string, command: string, executedCommand: string, result: SshResult): Promise<OutputFiles> {
	const dir = await mkdtemp(join(tmpdir(), "pi-execute-ssh-"));
	const stdoutPath = join(dir, "stdout.txt");
	const stderrPath = join(dir, "stderr.txt");
	const combinedPath = join(dir, "combined.txt");
	const stdoutContent = result.stdout;
	const stderrContent = result.stderr;
	const combinedContent = [
		`server: ${server}`,
		`called_command: ${command}`,
		`executed_command: ${executedCommand}`,
		`exit_code: ${result.code ?? "null"}`,
		`signal: ${result.signal ?? "none"}`,
		`timed_out: ${result.timedOut}`,
		"",
		"STDOUT:",
		stdoutContent,
		"",
		"STDERR:",
		stderrContent,
	].join("\n");

	await Promise.all([
		writeFile(stdoutPath, stdoutContent, "utf8"),
		writeFile(stderrPath, stderrContent, "utf8"),
		writeFile(combinedPath, combinedContent, "utf8"),
	]);

	return {
		dir,
		stdoutPath,
		stderrPath,
		combinedPath,
		stdoutBytes: Buffer.byteLength(stdoutContent, "utf8"),
		stderrBytes: Buffer.byteLength(stderrContent, "utf8"),
		combinedBytes: Buffer.byteLength(combinedContent, "utf8"),
		stdoutLines: countLines(stdoutContent),
		stderrLines: countLines(stderrContent),
		combinedLines: countLines(combinedContent),
	};
}

function formatResult(command: string, result: SshResult, files: OutputFiles): string {
	const parts: string[] = [];
	parts.push(`Called command:\n${command}`);
	parts.push(`Full output written to: ${files.combinedPath}`);
	parts.push(`stdout: ${files.stdoutPath} (${files.stdoutLines} lines, ${files.stdoutBytes} bytes)`);
	parts.push(`stderr: ${files.stderrPath} (${files.stderrLines} lines, ${files.stderrBytes} bytes)`);
	parts.push(`combined: ${files.combinedPath} (${files.combinedLines} lines, ${files.combinedBytes} bytes)`);
	parts.push("The previews below may omit the middle of long output; read the temp files for the full output.");

	if (result.stdout) parts.push(`STDOUT preview:\n${previewText(result.stdout)}`);
	if (result.stderr) parts.push(`STDERR preview:\n${previewText(result.stderr)}`);
	parts.push(`Exit code: ${result.code ?? "null"}`);
	if (result.signal) parts.push(`Signal: ${result.signal}`);
	if (result.timedOut) parts.push("Timed out: true");
	return parts.join("\n\n");
}
function countLines(text: string): number {
	if (!text) return 0;
	return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
}

function previewText(text: string): string {
	if (Buffer.byteLength(text, "utf8") <= PREVIEW_BYTES) return text;

	const lines = text.split(/\r?\n/);
	if (lines.length > PREVIEW_LINES * 2) {
		const head = lines.slice(0, PREVIEW_LINES).join("\n");
		const tail = lines.slice(-PREVIEW_LINES).join("\n");
		const omitted = lines.length - PREVIEW_LINES * 2;
		return clampPreview(
			`${head}\n\n... [${omitted} lines omitted; see temp file for full output] ...\n\n${tail}`,
			text,
		);
	}

	return clampPreview(text, text);
}

function clampPreview(preview: string, original: string): string {
	if (Buffer.byteLength(preview, "utf8") <= PREVIEW_BYTES) return preview;

	const half = Math.floor(PREVIEW_BYTES / 2);
	const head = preview.slice(0, half);
	const tail = preview.slice(-half);
	const omitted = Math.max(0, Buffer.byteLength(original, "utf8") - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8"));
	return `${head}\n\n... [${omitted} bytes omitted; see temp file for full output] ...\n\n${tail}`;
}

function textResult(text: string, isError: boolean, details: Record<string, unknown>) {
	return {
		isError,
		content: [{ type: "text" as const, text }],
		details,
	};
}
