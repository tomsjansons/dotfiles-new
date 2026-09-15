/**
 * Vision fallback for non-vision session models.
 *
 * When the session model cannot accept images (`model.input` lacks "image"),
 * a `read` on an image file would return an image content block that the
 * provider layer (e.g. pi-commandcode's assertTextOnlyMessages) rejects.
 * Instead of hard-failing, we route the image through a *configured*
 * vision-capable model and return a detailed text description.
 *
 * Config: `hashline-settings.json` in the agent dir
 *   { "visionFallback": { "provider": "commandcode", "model": "Qwen/Qwen3.7-Flash" } }
 * - No `visionFallback` key → no fallback; image blocks are dropped with a note.
 * - Missing/malformed file → default (commandcode + Qwen/Qwen3.7-Flash).
 * - `PI_HASHLINE_VISION_DISABLE=1` bypasses the fallback entirely.
 *
 * No auto-picking: the fallback model must be explicit in config (or default).
 *
 * NOTE on types: the extension workspace pins pi-coding-agent@0.74 for
 * type-checking, but the extension loader aliases the package to the host
 * pi's bundled code (0.84.1), where `ModelRegistry` has `find`,
 * `hasConfiguredAuth`, and `complete`. We therefore type registry access
 * structurally (matching `ExtensionContext["modelRegistry"]`) instead of
 * importing `Model` from the stale 0.74 type surface.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Default fallback: verified present + vision-capable in the commandcode provider. */
export const DEFAULT_VISION_FALLBACK = { provider: "commandcode", model: "Qwen/Qwen3.7-Flash" } as const;

/**
 * Output budget for the first describe attempt.
 *
 * Was 800, which is too small for a reasoning-capable describer: reasoning
 * tokens are billed against the same budget, so an attempt can end with zero
 * text blocks (observed: 18-31s calls returning an empty string) and real
 * descriptions arrived truncated (~2.8k chars ≈ the cap).
 */
export const DESCRIBE_MAX_TOKENS = 4000;
/** Retry budget when an attempt produced no text at all (reasoning-only answer). */
export const DESCRIBE_RETRY_MAX_TOKENS = 12000;
/** Describe attempts before giving up: first budget, then the retry budget. */
const DESCRIBE_BUDGETS = [DESCRIBE_MAX_TOKENS, DESCRIBE_RETRY_MAX_TOKENS] as const;

const SETTINGS_FILE = "hashline-settings.json";

export interface VisionFallbackConfig {
	provider: string;
	model: string;
}

/** The subset of a completion result we rely on (diagnostics for empty answers). */
export interface VisionCompletion {
	content: readonly { type: string; text?: string }[];
	stopReason?: string;
	usage?: { output?: number };
}

/** The subset of a Model we rely on. Structural: avoids the stale 0.74 type export. */
export interface VisionModel {
	readonly id: string;
	readonly provider: string;
	readonly input: readonly ("text" | "image")[];
}

/** True when the session model accepts image input. */
export function isVisionCapable(model: { readonly input?: unknown } | undefined): boolean {
	return !!model && Array.isArray(model.input) && model.input.includes("image");
}

/** Path to the settings file, resolved the same way as other agent-dir state. */
export function visionSettingsPath(): string {
	return join(getAgentDir(), SETTINGS_FILE);
}

interface SettingsFile {
	visionFallback?: VisionFallbackConfig;
}

/**
 * Load `{ visionFallback }` from hashline-settings.json.
 * Missing file / malformed JSON / absent key → undefined (caller decides
 * whether to fall back to the default). Unknown keys ignored.
 */
export async function loadVisionFallbackConfig(): Promise<VisionFallbackConfig | undefined> {
	try {
		const text = await readFile(visionSettingsPath(), "utf8");
		const parsed = JSON.parse(text) as SettingsFile;
		const cfg = parsed?.visionFallback;
		if (!cfg || typeof cfg.provider !== "string" || typeof cfg.model !== "string") return undefined;
		return { provider: cfg.provider, model: cfg.model };
	} catch {
		return undefined; // ENOENT or malformed JSON → treat as unset
	}
}

/** Registry operations the runtime exposes (find / hasConfiguredAuth / complete). */
export interface VisionRegistry {
	find(provider: string, modelId: string): unknown;
	hasConfiguredAuth(model: unknown): boolean;
	complete(model: unknown, context: unknown, options?: { maxTokens?: number; signal?: AbortSignal }): Promise<VisionCompletion>;
}

/**
 * Resolve the configured fallback Model. Returns undefined when:
 * - the model is not in the registry,
 * - the provider has no configured auth, or
 * - the configured model is not itself vision-capable (guard against
 *   misconfiguration — a text-only fallback would fail the same way).
 */
export async function resolveVisionFallbackModel(
	ctx: ExtensionContext,
	registry: VisionRegistry = ctx.modelRegistry as unknown as VisionRegistry,
): Promise<VisionModel | undefined> {
	const cfg = (await loadVisionFallbackConfig()) ?? DEFAULT_VISION_FALLBACK;
	const model = registry.find(cfg.provider, cfg.model);
	if (!model) return undefined;
	if (!isVisionCapable(model as { input?: unknown })) return undefined;
	if (!registry.hasConfiguredAuth(model)) return undefined;
	return model as VisionModel;
}

/** Text blocks of a completion, joined and trimmed (whitespace-only === empty). */
function completionText(result: VisionCompletion): string {
	return result.content
		.filter((c): c is { type: string; text: string } => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n")
		.trim();
}

/** Compact diagnostics for an attempt that produced no text (shown in the read note). */
function emptyAttemptDetail(result: VisionCompletion, maxTokens: number): string {
	const parts = [`maxTokens=${maxTokens}`];
	if (result.stopReason) parts.push(`stopReason=${result.stopReason}`);
	if (typeof result.usage?.output === "number") parts.push(`outputTokens=${result.usage.output}`);
	return parts.join(" ");
}

/**
 * Describe the image via the fallback model.
 *
 * Throws on failure (auth, network, ...) *and* on an empty answer: a model
 * that spends its whole output budget on reasoning returns no text blocks, and
 * silently handing "" to the caller is how a read ends up with a
 * `[Described by ...]` marker and nothing under it. One retry with a larger
 * budget, then throw with the stop reason so the read note says why.
 */
export async function describeImage(
	image: { data: string; mimeType: string },
	visionModel: VisionModel,
	ctx: ExtensionContext,
	registry: VisionRegistry = ctx.modelRegistry as unknown as VisionRegistry,
): Promise<string> {
	let lastDetail = "no attempt made";
	for (const maxTokens of DESCRIBE_BUDGETS) {
		const result = await registry.complete(
			visionModel,
			{
				systemPrompt:
					"You are an image description service. Describe the image in detail, including text/labels, layout, colors, and anything notable.",
				messages: [
					{
						role: "user",
						timestamp: Date.now(),
						content: [
							{
								type: "text",
								text: "Describe this image in detail, including text/labels, layout, colors, and anything notable.",
							},
							{ type: "image", data: image.data, mimeType: image.mimeType },
						],
					},
				],
			},
			{ maxTokens, signal: ctx.signal },
		);
		const text = completionText(result);
		if (text) return text;
		lastDetail = emptyAttemptDetail(result, maxTokens);
		if (ctx.signal?.aborted) break; // aborted: don't spend a second request
	}
	throw new Error(`returned no text (${lastDetail})`);
}
