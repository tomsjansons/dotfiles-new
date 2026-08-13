import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type Focusable,
	type TUI,
} from "@earendil-works/pi-tui";

type AvailableModel = ReturnType<ExtensionContext["modelRegistry"]["getAvailable"]>[number];

interface RecentModelsFile {
	recent: string[];
}

const STATE_PATH = join(getAgentDir(), "model-selector-recent.json");
const MAX_RECENT_MODELS = 200;
const MAX_VISIBLE_MODELS = 10;

function modelKey(model: AvailableModel): string {
	return `${model.provider}/${model.id}`;
}

async function loadRecentModels(): Promise<string[]> {
	try {
		const parsed = JSON.parse(await readFile(STATE_PATH, "utf8")) as Partial<RecentModelsFile>;
		return Array.isArray(parsed.recent)
			? parsed.recent.filter((value): value is string => typeof value === "string")
			: [];
	} catch {
		return [];
	}
}

async function saveRecentModels(recent: string[]): Promise<void> {
	await mkdir(getAgentDir(), { recursive: true });
	const temporaryPath = `${STATE_PATH}.${process.pid}.tmp`;
	await writeFile(temporaryPath, `${JSON.stringify({ recent }, null, 2)}\n`, "utf8");
	await rename(temporaryPath, STATE_PATH);
}

function mostRecentFirst(models: AvailableModel[], recent: string[]): AvailableModel[] {
	const rank = new Map(recent.map((key, index) => [key, index]));
	return [...models].sort((left, right) => {
		const leftRank = rank.get(modelKey(left)) ?? Number.MAX_SAFE_INTEGER;
		const rightRank = rank.get(modelKey(right)) ?? Number.MAX_SAFE_INTEGER;
		if (leftRank !== rightRank) return leftRank - rightRank;
		return modelKey(left).localeCompare(modelKey(right));
	});
}

class ModelSelector implements Component, Focusable {
	focused = false;
	private filter = "";
	private selectedIndex = 0;
	private filteredModels: AvailableModel[];

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly models: AvailableModel[],
		private readonly currentModelKey: string | undefined,
		private readonly done: (model: AvailableModel | undefined) => void,
	) {
		this.filteredModels = models;
		const currentIndex = currentModelKey
			? this.filteredModels.findIndex((model) => modelKey(model) === currentModelKey)
			: -1;
		this.selectedIndex = Math.max(0, currentIndex);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done(undefined);
			return;
		}
		if (matchesKey(data, "ctrl+n") || matchesKey(data, "down")) {
			this.moveSelection(1);
			return;
		}
		if (matchesKey(data, "ctrl+p") || matchesKey(data, "up")) {
			this.moveSelection(-1);
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			const selected = this.filteredModels[this.selectedIndex];
			if (selected) this.done(selected);
			return;
		}
		if (matchesKey(data, "backspace") || matchesKey(data, "delete")) {
			this.filter = Array.from(this.filter).slice(0, -1).join("");
			this.applyFilter();
			return;
		}
		if (matchesKey(data, "ctrl+u")) {
			this.filter = "";
			this.applyFilter();
			return;
		}

		// Ignore terminal escape sequences and control characters; printable input filters.
		if (data.startsWith("\x1b") || /[\x00-\x1f\x7f]/u.test(data)) return;
		this.filter += data;
		this.applyFilter();
	}

	render(width: number): string[] {
		const dialogWidth = Math.max(36, width);
		const innerWidth = dialogWidth - 2;
		const border = this.theme.fg("borderAccent", `┌${"─".repeat(innerWidth)}┐`);
		const bottomBorder = this.theme.fg("borderAccent", `└${"─".repeat(innerWidth)}┘`);
		const visibleModels = this.visibleWindow();
		const lines = [
			border,
			this.row(this.theme.bold(this.theme.fg("accent", " Select model")), innerWidth),
			this.row(
				`${this.theme.fg("muted", " Filter: ")}${this.filter}${this.focused ? CURSOR_MARKER : ""}`,
				innerWidth,
			),
			this.row("", innerWidth),
		];

		if (visibleModels.length === 0) {
			lines.push(this.row(this.theme.fg("muted", " No matching models"), innerWidth));
		} else {
			for (const { model, index } of visibleModels) {
				const selected = index === this.selectedIndex;
				const marker = selected ? this.theme.fg("accent", " › ") : "   ";
				const key = modelKey(model);
				const name = model.name && model.name !== model.id ? ` — ${model.name}` : "";
				const text = `${marker}${key}${name}`;
				lines.push(this.row(selected ? this.theme.bg("selectedBg", text) : text, innerWidth));
			}
		}

		lines.push(
			this.row("", innerWidth),
			this.row(
				this.theme.fg("muted", " Ctrl-N/P: move  Enter: select  Esc: cancel  Type to filter"),
				innerWidth,
			),
			bottomBorder,
		);
		return lines;
	}

	invalidate(): void {}

	private applyFilter(): void {
		const query = this.filter.toLocaleLowerCase();
		this.filteredModels = this.models.filter((model) => {
			const searchable = `${model.provider} ${model.id} ${model.name ?? ""}`.toLocaleLowerCase();
			return searchable.includes(query);
		});
		this.selectedIndex = 0;
		this.tui.requestRender();
	}

	private moveSelection(delta: number): void {
		if (this.filteredModels.length === 0) return;
		this.selectedIndex =
			(this.selectedIndex + delta + this.filteredModels.length) % this.filteredModels.length;
		this.tui.requestRender();
	}

	private visibleWindow(): Array<{ model: AvailableModel; index: number }> {
		const start = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(MAX_VISIBLE_MODELS / 2),
				this.filteredModels.length - MAX_VISIBLE_MODELS,
			),
		);
		return this.filteredModels
			.slice(start, start + MAX_VISIBLE_MODELS)
			.map((model, offset) => ({ model, index: start + offset }));
	}

	private row(content: string, width: number): string {
		const clipped = truncateToWidth(content, width);
		const padding = " ".repeat(Math.max(0, width - visibleWidth(clipped)));
		return `${this.theme.fg("borderAccent", "│")}${clipped}${padding}${this.theme.fg("borderAccent", "│")}`;
	}
}

export default function modelSelectorExtension(pi: ExtensionAPI): void {
	let recentModels: string[] = [];
	let stateLoaded = false;
	let selectorOpen = false;
	let saveQueue = Promise.resolve();

	const ensureStateLoaded = async (): Promise<void> => {
		if (stateLoaded) return;
		recentModels = await loadRecentModels();
		stateLoaded = true;
	};

	const rememberModel = async (key: string): Promise<void> => {
		await ensureStateLoaded();
		recentModels = [key, ...recentModels.filter((candidate) => candidate !== key)].slice(
			0,
			MAX_RECENT_MODELS,
		);
		saveQueue = saveQueue
			.catch(() => undefined)
			.then(() => saveRecentModels(recentModels))
			.catch(() => undefined);
		await saveQueue;
	};

	const promptForModel = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI || selectorOpen) return;
		await ensureStateLoaded();

		const currentKey = ctx.model ? modelKey(ctx.model) : undefined;
		if (currentKey) await rememberModel(currentKey);
		const models = mostRecentFirst(ctx.modelRegistry.getAvailable(), recentModels);
		if (models.length === 0) {
			ctx.ui.notify("No models with configured authentication are available", "warning");
			return;
		}

		selectorOpen = true;
		try {
			const selected = await ctx.ui.custom<AvailableModel | undefined>(
				(tui, theme, _keybindings, done) =>
					new ModelSelector(tui, theme, models, currentKey, done),
				{
					overlay: true,
					overlayOptions: {
						width: "70%",
						minWidth: 48,
						maxHeight: "75%",
						anchor: "center",
						margin: 1,
					},
				},
			);
			if (!selected) return;
			const changed = await pi.setModel(selected);
			if (!changed) {
				ctx.ui.notify(`Could not select ${modelKey(selected)}: authentication unavailable`, "error");
			}
		} finally {
			selectorOpen = false;
		}
	};

	pi.on("model_select", async (event) => {
		await rememberModel(modelKey(event.model));
	});

	pi.on("session_start", async (event, ctx) => {
		if (event.reason === "startup" || event.reason === "new") {
			await promptForModel(ctx);
		}
	});
}
