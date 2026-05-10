import { execFile } from "node:child_process";
import { relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "git-auto";
const STATE_TYPE = "git-auto-state";
const COMMIT_TIMEOUT_MS = 30_000;
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
	if (!enabled) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}

	const suffix = pendingCount > 0 ? ` ${pendingCount}` : "";
	ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("success", `git-auto:on${suffix}`));
}

function getMutationPath(event: ToolResultEvent, ctx: ExtensionContext): string | undefined {
	if (!MUTATION_TOOLS.has(event.toolName) || event.isError) return undefined;
	const path = event.input?.path;
	if (typeof path !== "string" || path.trim() === "") return undefined;
	return resolveMutationPath(ctx.cwd, path);
}

async function commitFiles(ctx: ExtensionContext, absolutePaths: string[]): Promise<{ committed: boolean; message?: string; skipped?: string }> {
	const git = await getGitContext(ctx.cwd);
	if (!git) return { committed: false, skipped: "not an eligible git branch" };

	const paths = [...new Set(absolutePaths.map((path) => toGitPath(git.root, path)).filter((path): path is string => !!path))];
	if (paths.length === 0) return { committed: false, skipped: "no changed files inside repo" };

	await execGit(["-C", git.root, "add", "-A", "--", ...paths]);

	const statusOutput = (await execGit(["-C", git.root, "status", "--porcelain=v1", "--", ...paths])).stdout;
	const statuses = parsePorcelainStatus(statusOutput);
	if (statuses.length === 0) return { committed: false, skipped: "no git changes" };

	const message = buildCommitMessage(statuses);
	await execGit(["-C", git.root, "commit", "-m", message, "--", ...paths]);
	return { committed: true, message };
}

export default function gitAutoExtension(pi: ExtensionAPI): void {
	let enabled = true;
	let pendingFiles = new Set<string>();

	pi.on("session_start", async (_event, ctx) => {
		enabled = restoreState(ctx);
		pendingFiles = new Set();
		updateStatus(ctx, enabled);
	});

	pi.registerCommand("git-auto", {
		description: "Toggle automatic git commits for hashline edit/write turns",
		handler: async (args, ctx) => {
			const value = args.trim().toLowerCase();
			if (value === "on" || value === "enable" || value === "enabled") {
				enabled = true;
			} else if (value === "off" || value === "disable" || value === "disabled") {
				enabled = false;
				pendingFiles.clear();
			} else if (value === "status") {
				ctx.ui.notify(`git-auto is ${enabled ? "on" : "off"}`, "info");
				updateStatus(ctx, enabled, pendingFiles.size);
				return;
			} else if (value === "") {
				enabled = !enabled;
				if (!enabled) pendingFiles.clear();
			} else {
				ctx.ui.notify("Usage: /git-auto [on|off|status]", "warning");
				return;
			}

			persistState(pi, enabled);
			updateStatus(ctx, enabled, pendingFiles.size);
			ctx.ui.notify(`git-auto ${enabled ? "enabled" : "disabled"}`, enabled ? "info" : "warning");
		},
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!enabled) return;
		const path = getMutationPath(event, ctx);
		if (!path) return;
		pendingFiles.add(path);
		updateStatus(ctx, enabled, pendingFiles.size);
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (!enabled || pendingFiles.size === 0) {
			updateStatus(ctx, enabled, pendingFiles.size);
			return;
		}

		const files = [...pendingFiles];
		pendingFiles.clear();
		updateStatus(ctx, enabled);

		try {
			const result = await commitFiles(ctx, files);
			if (result.committed) {
				ctx.ui.notify(`git-auto committed: ${result.message}`, "info");
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`git-auto commit failed: ${message}`, "error");
		}
	});
}
