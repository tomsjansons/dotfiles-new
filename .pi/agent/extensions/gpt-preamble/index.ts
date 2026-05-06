import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const STATUS_KEY = "gpt-preamble";
const WIDGET_KEY = "gpt-preamble";
const ENABLED_MODEL_IDS = new Set(["gpt-5.4", "gpt-5.5"]);
const MAX_PREAMBLE_CHARS = 240;

const PREAMBLE_INSTRUCTIONS = [
	"## Preamble Messages",
	"",
	"For non-trivial tool use, send a brief preamble before making tool calls.",
	"",
	"Rules:",
	"- Group related tool calls into one preamble instead of one note per tool.",
	"- Keep quick preambles to 1-2 short sentences, usually 8-12 words.",
	"- For later tool batches, connect what was found to the next concrete step.",
	"- Skip preambles for trivial single reads unless they are part of a larger grouped action.",
	"- Describe observable next actions only; do not reveal private reasoning.",
	"- Do not send a preamble when answering directly without tools.",
].join("\n");

type TurnState = {
	enabled: boolean;
	modelLabel?: string;
	toolStarted: boolean;
	assistantTextBeforeTool: string;
	shownPreamble?: string;
};

function modelParts(ctx: ExtensionContext): string[] {
	const model = ctx.model;
	if (!model) return [];

	const values = [
		model.id,
		model.name,
		model.provider,
		`${model.provider}/${model.id}`,
		`${model.provider}/${model.name ?? model.id}`,
	];

	return values
		.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
		.map((value) => value.toLowerCase());
}

function isPreambleModel(ctx: ExtensionContext): boolean {
	return modelParts(ctx).some((part) => {
		const normalized = part.replace(/^openai\//, "");
		return ENABLED_MODEL_IDS.has(normalized) || /(?:^|[/:-])gpt-5\.[45](?:$|[/:-])/.test(part);
	});
}

function modelLabel(ctx: ExtensionContext): string | undefined {
	const model = ctx.model;
	if (!model) return undefined;
	return `${model.provider}/${model.id}`;
}

function compactText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function assistantTextDelta(event: { assistantMessageEvent?: unknown }): string | undefined {
	const assistantEvent = event.assistantMessageEvent;
	if (!assistantEvent || typeof assistantEvent !== "object") return undefined;
	const typed = assistantEvent as { type?: unknown; delta?: unknown };
	if (typed.type !== "text_delta" || typeof typed.delta !== "string") return undefined;
	return typed.delta;
}

function resetUi(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEY, undefined);
	ctx.ui.setWidget(WIDGET_KEY, undefined);
}

function setEnabledStatus(ctx: ExtensionContext, label?: string): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", `preamble: ${label ?? "enabled"}`));
}

function showPreamble(ctx: ExtensionContext, text: string): void {
	if (!ctx.hasUI) return;
	const preamble = truncate(compactText(text), MAX_PREAMBLE_CHARS);
	if (!preamble) return;

	ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", "preamble shown"));
	ctx.ui.setWidget(
		WIDGET_KEY,
		(_tui, theme) => ({
			render(width: number) {
				const prefix = theme.fg("dim", "preamble: ");
				const maxText = Math.max(0, width - "preamble: ".length);
				return [prefix + truncate(preamble, maxText)];
			},
			invalidate() {},
		}),
		{ placement: "belowEditor" },
	);
}

export default function gptPreambleExtension(pi: ExtensionAPI): void {
	let state: TurnState = {
		enabled: false,
		toolStarted: false,
		assistantTextBeforeTool: "",
	};

	pi.on("session_start", async (_event, ctx) => {
		state = {
			enabled: isPreambleModel(ctx),
			modelLabel: modelLabel(ctx),
			toolStarted: false,
			assistantTextBeforeTool: "",
		};

		if (state.enabled) {
			setEnabledStatus(ctx, state.modelLabel);
		} else {
			resetUi(ctx);
		}
	});

	pi.on("model_select", async (_event, ctx) => {
		state.enabled = isPreambleModel(ctx);
		state.modelLabel = modelLabel(ctx);
		state.toolStarted = false;
		state.assistantTextBeforeTool = "";
		state.shownPreamble = undefined;

		if (state.enabled) {
			setEnabledStatus(ctx, state.modelLabel);
		} else {
			resetUi(ctx);
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		state.enabled = isPreambleModel(ctx);
		state.modelLabel = modelLabel(ctx);
		state.toolStarted = false;
		state.assistantTextBeforeTool = "";
		state.shownPreamble = undefined;

		if (!state.enabled) {
			resetUi(ctx);
			return undefined;
		}

		setEnabledStatus(ctx, state.modelLabel);
		return {
			systemPrompt: `${event.systemPrompt}\n\n${PREAMBLE_INSTRUCTIONS}`,
		};
	});

	pi.on("message_update", async (event) => {
		if (!state.enabled || state.toolStarted) return;

		const delta = assistantTextDelta(event);
		if (!delta) return;

		state.assistantTextBeforeTool += delta;
	});

	pi.on("tool_execution_start", async (_event, ctx) => {
		if (!state.enabled) return;
		if (state.toolStarted) return;

		state.toolStarted = true;
		const preamble = compactText(state.assistantTextBeforeTool);
		if (preamble) {
			state.shownPreamble = preamble;
			showPreamble(ctx, preamble);
		} else {
			setEnabledStatus(ctx, state.modelLabel);
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		state.toolStarted = false;
		state.assistantTextBeforeTool = "";
		state.shownPreamble = undefined;

		if (state.enabled) {
			setEnabledStatus(ctx, state.modelLabel);
			if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
		} else {
			resetUi(ctx);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		resetUi(ctx);
	});
}
