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

const SETTINGS_FILE = "hashline-settings.json";

export interface VisionFallbackConfig {
	provider: string;
	model: string;
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
	complete(model: unknown, context: unknown, options?: { maxTokens?: number; signal?: AbortSignal }): Promise<{
		content: readonly { type: string; text?: string }[];
	}>;
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

/** Describe the image via the fallback model. Throws on failure (auth, network, ...). */
export async function describeImage(
	image: { data: string; mimeType: string },
	visionModel: VisionModel,
	ctx: ExtensionContext,
	registry: VisionRegistry = ctx.modelRegistry as unknown as VisionRegistry,
): Promise<string> {
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
		{ maxTokens: 800, signal: ctx.signal },
	);
	return result.content
		.filter((c): c is { type: string; text?: string } => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text as string)
		.join("\n");
}
