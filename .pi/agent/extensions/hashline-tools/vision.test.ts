/**
 * Unit tests for the vision fallback module (see VISION-READ-PLAN.md).
 * Run with jiti, same as the other tests: `jiti vision.test.ts`.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isVisionCapable, loadVisionFallbackConfig, resolveVisionFallbackModel, visionSettingsPath, describeImage, DEFAULT_VISION_FALLBACK, DESCRIBE_MAX_TOKENS, DESCRIBE_RETRY_MAX_TOKENS } from "./vision";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? " " + detail : ""}`);
	if (!ok) failures++;
}

// --- isVisionCapable ---
check("vision model → true", isVisionCapable({ input: ["text", "image"] }));
check("text-only model → false", !isVisionCapable({ input: ["text"] }));
check("undefined model → false", !isVisionCapable(undefined));
check("null model → false", !isVisionCapable(null));
check("missing input field → false", !isVisionCapable({}));
check("input includes image with other types → true", isVisionCapable({ input: ["image", "text", "audio"] }));

// --- loadVisionFallbackConfig (pure-logic tests; full file round-trip is in smoke.ts) ---
// resolveVisionFallbackModel with a registry that never finds anything
const emptyRegistryCtx = {
	modelRegistry: {
		find: () => undefined,
		hasConfiguredAuth: () => false,
	},
} as any;

const r1 = await resolveVisionFallbackModel(emptyRegistryCtx);
check("default fallback not resolvable without registry → undefined", r1 === undefined);

// found but no auth → undefined
const noAuthCtx = {
	modelRegistry: {
		find: (p: string, m: string) => (p === "commandcode" && m === "Qwen/Qwen3.7-Flash" ? { id: m, provider: p, input: ["text", "image"] } : undefined),
		hasConfiguredAuth: () => false,
	},
} as any;
check("no auth → undefined", (await resolveVisionFallbackModel(noAuthCtx)) === undefined);

// found, auth, vision-capable → resolved
const okModel = { id: "Qwen/Qwen3.7-Flash", provider: "commandcode", input: ["text", "image"] };
const okCtx = {
	modelRegistry: {
		find: (p: string, m: string) => (p === "commandcode" && m === "Qwen/Qwen3.7-Flash" ? okModel : undefined),
		hasConfiguredAuth: () => true,
	},
} as any;
check("resolved when found+auth+vision", (await resolveVisionFallbackModel(okCtx)) === okModel);

// found, auth, but NOT vision-capable → undefined (misconfiguration guard)
const textOnly = { id: "Qwen/Qwen3.7-Flash", provider: "commandcode", input: ["text"] };
const textOnlyCtx = {
	modelRegistry: {
		find: () => textOnly,
		hasConfiguredAuth: () => true,
	},
} as any;
check("non-vision configured model → undefined", (await resolveVisionFallbackModel(textOnlyCtx)) === undefined);

// --- describeImage (registry.complete contract) ---
let calledWith: any;
let callCount = 0;
const completeCtx = {
	modelRegistry: {
		complete: async (model: unknown, context: unknown, options: unknown) => {
			calledWith = { model, context, options };
			callCount++;
			return { content: [{ type: "text", text: "A cat." }] };
		},
	},
} as any;
const desc = await describeImage({ data: "QUJD", mimeType: "image/png" }, okModel, completeCtx);
check("describeImage returns text", desc === "A cat.");
check("describeImage passes first-attempt maxTokens", calledWith.options.maxTokens === DESCRIBE_MAX_TOKENS, String(calledWith.options.maxTokens));
check("describeImage does not retry a successful attempt", callCount === 1, String(callCount));
check("describeImage passes signal through", calledWith.options.signal === undefined);
check("describeImage sends image block", calledWith.context.messages[0].content[1].type === "image" && calledWith.context.messages[0].content[1].data === "QUJD");
check("describeImage uses vision model", calledWith.model === okModel);

// A reasoning-only answer (no text blocks) is retried once at the larger budget.
let attempts = 0;
const budgets: number[] = [];
const retryCtx = {
	modelRegistry: {
		complete: async (_m: unknown, _c: unknown, o: any) => {
			attempts++;
			budgets.push(o.maxTokens);
			return attempts === 1
				? { content: [{ type: "thinking", text: "reasoning" }], stopReason: "length", usage: { output: DESCRIBE_MAX_TOKENS } }
				: { content: [{ type: "text", text: "  A dog. \n" }], stopReason: "stop" };
		},
	},
} as any;
const retried = await describeImage({ data: "QUJD", mimeType: "image/png" }, okModel, retryCtx);
check("empty answer retries once at the larger budget", attempts === 2 && budgets[1] === DESCRIBE_RETRY_MAX_TOKENS, JSON.stringify(budgets));
check("retried description is trimmed", retried === "A dog.", JSON.stringify(retried));

// Whitespace-only text is not a description either.
let wsAttempts = 0;
const wsCtx = {
	modelRegistry: {
		complete: async () => {
			wsAttempts++;
			return { content: [{ type: "text", text: "  \n  " }] };
		},
	},
} as any;
let wsErr = "";
try {
	await describeImage({ data: "QUJD", mimeType: "image/png" }, okModel, wsCtx);
} catch (e) {
	wsErr = e instanceof Error ? e.message : String(e);
}
check("whitespace-only answer counts as empty and throws", wsAttempts === 2 && wsErr.includes("returned no text"), `${wsAttempts} ${wsErr}`);

// Every attempt empty → throw with diagnostics instead of returning "" (the
// old behaviour that produced a `[Described by ...]` marker over nothing).
let deadAttempts = 0;
const deadCtx = {
	modelRegistry: {
		complete: async () => {
			deadAttempts++;
			return { content: [], stopReason: "length", usage: { output: DESCRIBE_RETRY_MAX_TOKENS } };
		},
	},
} as any;
let deadErr = "";
try {
	await describeImage({ data: "QUJD", mimeType: "image/png" }, okModel, deadCtx);
} catch (e) {
	deadErr = e instanceof Error ? e.message : String(e);
}
check(
	"all-empty → throws with stop reason + token budget",
	deadAttempts === 2 && deadErr.includes("returned no text") && deadErr.includes("stopReason=length") && deadErr.includes(`outputTokens=${DESCRIBE_RETRY_MAX_TOKENS}`) && deadErr.includes(`maxTokens=${DESCRIBE_RETRY_MAX_TOKENS}`),
	`${deadAttempts} ${deadErr}`,
);

// An aborted read must not spend a second request.
let abortAttempts = 0;
const abortCtx = {
	signal: { aborted: true },
	modelRegistry: {
		complete: async () => {
			abortAttempts++;
			return { content: [], stopReason: "error" };
		},
	},
} as any;
let abortErr = "";
try {
	await describeImage({ data: "QUJD", mimeType: "image/png" }, okModel, abortCtx);
} catch (e) {
	abortErr = e instanceof Error ? e.message : String(e);
}
check("aborted context does not retry", abortAttempts === 1 && abortErr.includes("returned no text"), `${abortAttempts} ${abortErr}`);

// default config constant sanity
check("default fallback is commandcode Qwen3.7-Flash", DEFAULT_VISION_FALLBACK.provider === "commandcode" && DEFAULT_VISION_FALLBACK.model === "Qwen/Qwen3.7-Flash");

// settings path ends in agent dir + filename
check("settings path basename", visionSettingsPath().endsWith("/hashline-settings.json"));

console.log(failures === 0 ? "\nVISION UNIT ALL PASS" : `\n${failures} VISION UNIT FAILURES`);
process.exit(failures === 0 ? 0 : 1);
