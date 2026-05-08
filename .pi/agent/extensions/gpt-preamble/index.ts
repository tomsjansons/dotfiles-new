import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const ENABLED_MODEL_IDS = new Set(["gpt-5.4", "gpt-5.5"]);

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


export default function gptPreambleExtension(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (event, ctx) => {
		if (!isPreambleModel(ctx)) return undefined;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${PREAMBLE_INSTRUCTIONS}`,
		};
	});
}
