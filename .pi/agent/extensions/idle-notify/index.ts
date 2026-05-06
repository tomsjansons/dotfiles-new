import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";

const CLASSIFIER_MODEL = process.env.PI_IDLE_NOTIFY_MODEL ?? "openrouter/google/gemini-2.0-flash-lite-001";
const CLASSIFIER_TIMEOUT_MS = Number(process.env.PI_IDLE_NOTIFY_TIMEOUT_MS ?? 12000);
const NOTIFICATION_TIMEOUT_MS = Number(process.env.PI_IDLE_NOTIFY_NOTIFICATION_TIMEOUT_MS ?? 60000);
const MAX_MESSAGE_CHARS = Number(process.env.PI_IDLE_NOTIFY_MAX_MESSAGE_CHARS ?? 8000);

type IdleStatus = "WAITING" | "DONE";

type AssistantTextBlock = {
	type: string;
	text?: string;
};

type AssistantMessageLike = {
	role: string;
	content?: string | AssistantTextBlock[];
};

function isAssistantMessage(message: unknown): message is AssistantMessageLike {
	return !!message && typeof message === "object" && (message as { role?: string }).role === "assistant";
}

function getAssistantText(message: AssistantMessageLike): string {
	if (typeof message.content === "string") return message.content.trim();
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((block): block is AssistantTextBlock => !!block && block.type === "text" && typeof block.text === "string")
		.map((block) => block.text!.trim())
		.filter(Boolean)
		.join("\n");
}

function compactWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function fallbackNeedsInput(lastMessage: string): boolean {
	const compact = compactWhitespace(lastMessage);
	if (!compact) return false;
	return /\?|\b(please|can you|could you|would you|which|what|where|when|why|how|choose|confirm|decide|provide|share|tell me|let me know|want me to|input needed|reply with|send me|pick one)\b/i.test(
		compact,
	);
}

function parseIdleStatus(stdout: string): IdleStatus | null {
	const firstLine = stdout
		.split(/\r?\n/)
		.map((line) => line.trim().toUpperCase())
		.find(Boolean);
	if (firstLine === "WAITING" || firstLine === "DONE") return firstLine;
	return null;
}

function runCommand(
	command: string,
	args: string[],
	options: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let finished = false;
		let timeout: NodeJS.Timeout | undefined;

		child.stdout?.on("data", (chunk) => {
			stdout += String(chunk);
		});

		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});

		child.on("error", (error) => {
			if (finished) return;
			finished = true;
			if (timeout) clearTimeout(timeout);
			reject(error);
		});

		child.on("close", (code) => {
			if (finished) return;
			finished = true;
			if (timeout) clearTimeout(timeout);
			resolve({ code, stdout, stderr });
		});

		if (options.timeoutMs && options.timeoutMs > 0) {
			timeout = setTimeout(() => {
				if (finished) return;
				finished = true;
				child.kill("SIGTERM");
				reject(new Error(`${command} timed out after ${options.timeoutMs}ms`));
			}, options.timeoutMs);
		}
	});
}

async function classifyIdleStatus(lastMessage: string, cwd: string): Promise<IdleStatus | null> {
	if (!lastMessage) return "DONE";

	const prompt = [
		"Classify the assistant's final message for a desktop idle notification.",
		"Return exactly one word:",
		"WAITING - the assistant still needs user input, missing information, a choice, or confirmation.",
		"DONE - the assistant finished and is not waiting for anything.",
		"Do not add any other text.",
		"",
		"Assistant message:",
		truncate(lastMessage, MAX_MESSAGE_CHARS),
	].join("\n");

	const result = await runCommand(
		"pi",
		[
			"-p",
			"--no-session",
			"--no-tools",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--thinking",
			"off",
			"--model",
			CLASSIFIER_MODEL,
			prompt,
		],
		{ cwd, timeoutMs: CLASSIFIER_TIMEOUT_MS },
	);

	if (result.code !== 0) return null;
	return parseIdleStatus(result.stdout);
}

function sendNotification(title: string, body: string, urgency: "low" | "normal"): void {
	const child = spawn("notify-send", ["-u", urgency, "-t", String(NOTIFICATION_TIMEOUT_MS), title, body], {
		stdio: "ignore",
		detached: true,
	});
	child.on("error", () => undefined);
	child.unref();
}

export default function idleNotifyExtension(pi: ExtensionAPI): void {
	pi.on("agent_end", async (event, ctx) => {
		if (process.env.PI_IDLE_NOTIFY_DISABLED === "1") return;
		if (Number(process.env.PI_SUBAGENT_DEPTH ?? "0") > 0) return;

		const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
		const lastMessage = compactWhitespace(lastAssistant ? getAssistantText(lastAssistant) : "");
		const idleStatus = (await classifyIdleStatus(lastMessage, ctx.cwd).catch(() => null)) ??
			(fallbackNeedsInput(lastMessage) ? "WAITING" : "DONE");

		const waitingForInput = idleStatus === "WAITING";
		const emoji = waitingForInput ? "❓" : "✅";
		const title = waitingForInput ? `${emoji} Pi idle — input needed` : `${emoji} Pi idle — task done`;
		const body = `📁 ${ctx.cwd}`;

		sendNotification(title, body, waitingForInput ? "normal" : "low");
	});
}
