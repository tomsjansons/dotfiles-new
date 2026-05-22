import { execFile } from "node:child_process";
import { relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "git-auto";
const STATE_TYPE = "git-auto-state";
const COMMIT_TIMEOUT_MS = 30_000;
const MESSAGE_TIMEOUT_MS = 60_000;
const MAX_AGENT_RESPONSE_CHARS = 4_000;
const PROTECTED_BRANCHES = new Set(["main", "master"]);
const MUTATION_TOOLS = new Set(["edit", "write"]);

type GitAutoState = {
	enabled?: boolean;
};

type CommandResult = {
	stdout: string;
	stderr: string;
};

type GitContext = {
	root: string;
	branch: string;
};

type StatusEntry = {
	code: string;
	path: string;
};

type AssistantMessageLike = {
	role?: unknown;
	stopReason?: unknown;
	errorMessage?: unknown;
	content?: unknown;
};

function isPrintMode(): boolean {
	return process.argv.some((arg) => arg === "-p" || arg === "--print");
}

function execGit(args: string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			"git",
			args,
			{
				cwd: options.cwd,
				encoding: "utf8",
				maxBuffer: 1024 * 1024,
				timeout: options.timeoutMs ?? COMMIT_TIMEOUT_MS,
			},
			(error, stdout, stderr) => {
				if (error) {
					const message = stderr?.trim() || error.message;
					reject(new Error(message));
					return;
				}
				resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
			},
		);
		child.on("error", reject);
	});
}

function execPi(args: string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			"pi",
			args,
			{
				cwd: options.cwd,
				encoding: "utf8",
				maxBuffer: 1024 * 1024,
				timeout: options.timeoutMs ?? MESSAGE_TIMEOUT_MS,
			},
			(error, stdout, stderr) => {
				if (error) {
					const message = stderr?.trim() || error.message;
					reject(new Error(message));
					return;
				}
				resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
			},
		);
		child.on("error", reject);
	});
}

async function getGitContext(cwd: string): Promise<GitContext | undefined> {
	try {
		const root = (await execGit(["-C", cwd, "rev-parse", "--show-toplevel"])).stdout.trim();
		if (!root) return undefined;

		const branch = (await execGit(["-C", root, "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
		if (!branch || branch === "HEAD") return undefined;
		if (PROTECTED_BRANCHES.has(branch)) return undefined;

		return { root, branch };
	} catch {
		return undefined;
	}
}

function resolveMutationPath(cwd: string, path: string): string {
	const normalized = path.startsWith("@") ? path.slice(1) : path;
	return resolve(cwd, normalized);
}

function toGitPath(root: string, absolutePath: string): string | undefined {
	const rel = relative(root, absolutePath);
	if (!rel || rel === ".") return undefined;
	if (rel.startsWith("..") || rel.includes(`${sep}..${sep}`)) return undefined;
	return sep === "/" ? rel : rel.split(sep).join("/");
}

function parsePorcelainStatus(output: string): StatusEntry[] {
	return output
		.split("\n")
		.map((line) => line.trimEnd())
		.filter(Boolean)
		.map((line) => {
			const code = line.slice(0, 2);
			const rawPath = line.slice(3).trim();
			const renameArrow = " -> ";
			const path = rawPath.includes(renameArrow) ? rawPath.slice(rawPath.lastIndexOf(renameArrow) + renameArrow.length) : rawPath;
			return { code, path };
		});
}

function humanizePath(path: string): string {
	const parts = path.split("/").filter(Boolean);
	const file = parts.at(-1) ?? path;
	const parent = parts.at(-2);

	if (file === "index.ts" && parent) return `${parent} extension`;
	if (file === "package.json") return parent ? `${parent} package metadata` : "package metadata";
	if (file === "README.md") return parent ? `${parent} docs` : "docs";

	return file
		.replace(/\.[^.]+$/, "")
		.replace(/[-_]+/g, " ")
		.trim() || file;
}

function commonDirectory(paths: string[]): string | undefined {
	const directories = paths
		.map((path) => path.split("/").slice(0, -1).join("/"))
		.filter(Boolean);
	if (directories.length === 0) return undefined;
	const first = directories[0].split("/");
	let length = first.length;
	for (const directory of directories.slice(1)) {
		const parts = directory.split("/");
		while (length > 0 && first.slice(0, length).join("/") !== parts.slice(0, length).join("/")) {
			length -= 1;
		}
	}
	return length > 0 ? first.slice(0, length).join("/") : undefined;
}

function buildCommitMessage(statuses: StatusEntry[]): string {
	const paths = statuses.map((entry) => entry.path);
	const codes = statuses.map((entry) => entry.code);
	const allAdded = codes.every((code) => code.includes("A") || code === "??");
	const allDeleted = codes.every((code) => code.includes("D"));
	const verb = allAdded ? "add" : allDeleted ? "remove" : "update";

	if (paths.length === 1) return `ai: ${verb} ${humanizePath(paths[0])}`;

	const directory = commonDirectory(paths);
	if (directory) return `ai: ${verb} ${directory}`;

	return `ai: ${verb} ${paths.length} files`;
}

function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.flatMap((block) => {
			if (!block || typeof block !== "object") return [];
			const record = block as Record<string, unknown>;
			return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
		})
		.join("\n")
		.trim();
}

function getLastAssistantText(messages: unknown[]): string | undefined {
	const text = extractTextContent(getLastAssistantMessage(messages)?.content);
	return text ? text : undefined;
}

function cleanCommitMessage(message: string): string | undefined {
	const subject = message
		.split("\n")
		.map((line) => line.trim().replace(/^[-*`"']+|[`"']+$/g, ""))
		.find(Boolean);
	if (!subject) return undefined;

	const normalized = subject.replace(/\s+/g, " ").replace(/[.!?]+$/g, "").slice(0, 72).trim();
	if (!normalized) return undefined;

	return normalized.toLowerCase().startsWith("ai: ") ? normalized : `ai: ${normalized}`;
}

async function buildCommitMessageFromAgentResponse(
	root: string,
	statuses: StatusEntry[],
	agentResponse: string | undefined,
): Promise<string | undefined> {
	if (!agentResponse) return undefined;

	const fallback = buildCommitMessage(statuses);
	const prompt = [
		"Write a concise Git commit subject for the completed coding-agent work.",
		"Use the agent's final response as the primary source of intent.",
		"Rules:",
		"- Return exactly one line, no markdown, no quotes.",
		"- Start with \"ai: \".",
		"- Use imperative mood after the prefix, e.g. \"ai: improve git-auto commit subjects\".",
		"- Be specific about the user-visible change, not just the filenames.",
		"- Keep it under 72 characters.",
		"",
		"Changed files:",
		...statuses.map((entry) => `- ${entry.code.trim() || "M"} ${entry.path}`),
		"",
		"Fallback if the response is unclear:",
		fallback,
		"",
		"Agent final response:",
		agentResponse.slice(0, MAX_AGENT_RESPONSE_CHARS),
	].join("\n");

	try {
		const result = await execPi(["-p", prompt], { cwd: root, timeoutMs: MESSAGE_TIMEOUT_MS });
		return cleanCommitMessage(result.stdout);
	} catch {
		return undefined;
	}
}

function getLastAssistantMessage(messages: unknown[]): AssistantMessageLike | undefined {
	return [...messages]
		.reverse()
		.find((message): message is AssistantMessageLike => {
			return !!message && typeof message === "object" && (message as AssistantMessageLike).role === "assistant";
		});
}

function getAgentEndStopReason(messages: unknown[]): string | undefined {
	const assistant = getLastAssistantMessage(messages);
	return typeof assistant?.stopReason === "string" ? assistant.stopReason : undefined;
}

function shouldCommitAgentEnd(messages: unknown[]): boolean {
	return getAgentEndStopReason(messages) === "stop";
}

function restoreState(ctx: ExtensionContext): boolean {
	let enabled = true;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
		const state = entry.data as GitAutoState | undefined;
		if (typeof state?.enabled === "boolean") enabled = state.enabled;
	}
	return enabled;
}

function persistState(pi: ExtensionAPI, enabled: boolean): void {
	pi.appendEntry<GitAutoState>(STATE_TYPE, { enabled });
}

function updateStatus(ctx: ExtensionContext, enabled: boolean, pendingCount = 0): void {
	try {
		if (isPrintMode() || !ctx.hasUI) return;
		if (!enabled) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}

		const suffix = pendingCount > 0 ? ` ${pendingCount}` : "";
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("success", `git-auto:on${suffix}`));
	} catch {
		// Contexts can be invalidated during print-mode/session teardown; UI status is best-effort.
	}
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	try {
		if (isPrintMode() || !ctx.hasUI) return;
		ctx.ui.notify(message, type);
	} catch {
		// Ignore stale context errors after session teardown; git work itself uses plain cwd/path data.
	}
}

function getMutationPath(event: ToolResultEvent, ctx: ExtensionContext): string | undefined {
	if (!MUTATION_TOOLS.has(event.toolName) || event.isError) return undefined;
	const path = event.input?.path;
	if (typeof path !== "string" || path.trim() === "") return undefined;
	return resolveMutationPath(ctx.cwd, path);
}

async function commitFiles(
	cwd: string,
	absolutePaths: string[],
	agentResponse?: string,
): Promise<{ committed: boolean; message?: string; skipped?: string }> {
	const git = await getGitContext(cwd);
	if (!git) return { committed: false, skipped: "not an eligible git branch" };

	const paths = [...new Set(absolutePaths.map((path) => toGitPath(git.root, path)).filter((path): path is string => !!path))];
	if (paths.length === 0) return { committed: false, skipped: "no changed files inside repo" };

	await execGit(["-C", git.root, "add", "-A", "--", ...paths]);

	const statusOutput = (await execGit(["-C", git.root, "status", "--porcelain=v1", "--", ...paths])).stdout;
	const statuses = parsePorcelainStatus(statusOutput);
	if (statuses.length === 0) return { committed: false, skipped: "no git changes" };

	const message = (await buildCommitMessageFromAgentResponse(git.root, statuses, agentResponse)) ?? buildCommitMessage(statuses);
	await execGit(["-C", git.root, "commit", "-m", message, "--", ...paths]);
	return { committed: true, message };
}

export default function gitAutoExtension(pi: ExtensionAPI): void {
	let enabled = true;
	let pendingFiles = new Set<string>();

	pi.on("session_start", async (_event, ctx) => {
		try {
			enabled = restoreState(ctx);
			pendingFiles = new Set();
			updateStatus(ctx, enabled);
		} catch {
			// Ignore stale context during print-mode/session teardown.
		}
	});

	pi.registerCommand("git-auto", {
		description: "Toggle automatic git commits for each completed agent response",
		handler: async (args, ctx) => {
			const value = args.trim().toLowerCase();
			if (value === "on" || value === "enable" || value === "enabled") {
				enabled = true;
			} else if (value === "off" || value === "disable" || value === "disabled") {
				enabled = false;
				pendingFiles.clear();
			} else if (value === "status") {
				notify(ctx, `git-auto is ${enabled ? "on" : "off"}`, "info");
				updateStatus(ctx, enabled, pendingFiles.size);
				return;
			} else if (value === "") {
				enabled = !enabled;
				if (!enabled) pendingFiles.clear();
			} else {
				notify(ctx, "Usage: /git-auto [on|off|status]", "warning");
				return;
			}

			persistState(pi, enabled);
			updateStatus(ctx, enabled, pendingFiles.size);
			notify(ctx, `git-auto ${enabled ? "enabled" : "disabled"}`, enabled ? "info" : "warning");
		},
	});

	pi.on("tool_result", async (event, ctx) => {
		try {
			if (!enabled) return;
			const path = getMutationPath(event, ctx);
			if (!path) return;
			pendingFiles.add(path);
			updateStatus(ctx, enabled, pendingFiles.size);
		} catch {
			// Ignore stale context during print-mode/session teardown.
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		let cwd: string;
		try {
			cwd = ctx.cwd;
		} catch {
			return;
		}

		if (!enabled || pendingFiles.size === 0) {
			updateStatus(ctx, enabled, pendingFiles.size);
			return;
		}

		if (!shouldCommitAgentEnd(event.messages)) {
			const stopReason = getAgentEndStopReason(event.messages) ?? "unknown";
			const skippedCount = pendingFiles.size;
			pendingFiles.clear();
			updateStatus(ctx, enabled);
			notify(ctx, `git-auto skipped commit for ${skippedCount} file${skippedCount === 1 ? "" : "s"}: agent ended with ${stopReason}`, "warning");
			return;
		}

		const files = [...pendingFiles];
		const agentResponse = getLastAssistantText(event.messages);
		pendingFiles.clear();
		updateStatus(ctx, enabled);

		try {
			const result = await commitFiles(cwd, files, agentResponse);
			if (result.committed) {
				notify(ctx, `git-auto committed: ${result.message}`, "info");
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			notify(ctx, `git-auto commit failed: ${message}`, "error");
		}
	});
}
