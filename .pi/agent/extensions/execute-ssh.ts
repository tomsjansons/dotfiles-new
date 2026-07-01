import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_TIMEOUT_MS = 120_000;
const PREVIEW_LINES = 100;
const PREVIEW_BYTES = 64_000;
const SUDO_PROMPT_TOKEN = "__PI_EXECUTE_SSH_SUDO_PASSWORD__";

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

				sudoPassword = await ctx.ui.input(
					"Remote sudo password required",
					`Server: ${server}\nCommand: ${command}\n\nPassword is sent to remote sudo via ssh stdin and is not returned to the model.`,
				);

				if (!sudoPassword) {
					return textResult("Cancelled: no remote sudo password provided.", true, { server, command });
				}
			}

			try {
				const result = await runSsh({
					server,
					command: sudo ? buildSudoCommand(command) : command,
					sudoPassword,
					timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
					signal,
				});
				if (sudoPassword) {
					result.stdout = redactSecret(result.stdout, sudoPassword);
					result.stderr = redactSecret(result.stderr, sudoPassword);
				}

				const outputFiles = await writeOutputFiles(server, command, result);
				const text = formatResult(result, outputFiles);
				return {
					isError: result.code !== 0 || result.timedOut,
					content: [{ type: "text" as const, text }],
					details: {
						server,
						command,
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

function isSudoCommand(command: string): boolean {
	return /^sudo(?:\s|$)/.test(command.trim());
}

function buildSudoCommand(command: string): string {
	return command.replace(/^sudo\b/, `sudo -k -p ${shellQuote(SUDO_PROMPT_TOKEN)}`);
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function redactSecret(text: string, secret: string): string {
	if (!secret) return text;
	return text.split(secret).join("[redacted sudo password]");
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

		let passwordSent = false;
		const sendPasswordIfPrompted = () => {
			const hasPrompt = stdout.includes(SUDO_PROMPT_TOKEN) || stderr.includes(SUDO_PROMPT_TOKEN);
			if (hasPrompt) {
				stdout = stdout.split(SUDO_PROMPT_TOKEN).join("");
				stderr = stderr.split(SUDO_PROMPT_TOKEN).join("");
			}
			if (!hasPrompt || passwordSent || !options.sudoPassword) return;
			passwordSent = true;
			child.stdin.write(`${options.sudoPassword}\n`);
			setTimeout(() => child.stdin.end(), 100).unref();
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

async function writeOutputFiles(server: string, command: string, result: SshResult): Promise<OutputFiles> {
	const dir = await mkdtemp(join(tmpdir(), "pi-execute-ssh-"));
	const stdoutPath = join(dir, "stdout.txt");
	const stderrPath = join(dir, "stderr.txt");
	const combinedPath = join(dir, "combined.txt");
	const stdoutContent = result.stdout;
	const stderrContent = result.stderr;
	const combinedContent = [
		`server: ${server}`,
		`command: ${command}`,
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

function formatResult(result: SshResult, files: OutputFiles): string {
	const parts: string[] = [];
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
	if (text.length <= PREVIEW_BYTES) return text;

	const lines = text.split(/\r?\n/);
	if (lines.length > PREVIEW_LINES * 2) {
		const head = lines.slice(0, PREVIEW_LINES).join("\n");
		const tail = lines.slice(-PREVIEW_LINES).join("\n");
		const omitted = lines.length - PREVIEW_LINES * 2;
		return `${head}\n\n... [${omitted} lines omitted; see temp file for full output] ...\n\n${tail}`;
	}

	const head = text.slice(0, PREVIEW_BYTES / 2);
	const tail = text.slice(-PREVIEW_BYTES / 2);
	const omitted = text.length - PREVIEW_BYTES;
	return `${head}\n\n... [${omitted} bytes omitted; see temp file for full output] ...\n\n${tail}`;
}

function textResult(text: string, isError: boolean, details: Record<string, unknown>) {
	return {
		isError,
		content: [{ type: "text" as const, text }],
		details,
	};
}
