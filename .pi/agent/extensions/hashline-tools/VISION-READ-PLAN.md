# Plan: Vision-capable `read` fallback for non-vision models

## Problem

When the session model has no image input capability (e.g. `deepseek/deepseek-v4-flash`, the
current `defaultModel`), a `read` on an image file returns an `image` content block. The provider
layer (e.g. `pi-commandcode-provider`'s `assertTextOnlyMessages`) then throws:

```
Selected Command Code model does not support image content in tool results
```

and the tool call errors out. The built-in read already *intends* to handle this
(`getNonVisionImageNote()` in `dist/core/tools/read.js` adds "[Current model does not support
images. The image will be omitted from this request.]"), but the note is dead code in the
extension path: the note is only consulted when `ctx?.model` is passed to the tool's `execute`,
and the extension registration path never supplies `ctx` (see Findings below). And even when it
did, it would only *omit* the image — it would not describe it.

## Goal

- Detect whether the session model is vision-capable (`model.input.includes("image")`).
- If capable → behave exactly as today (delegate to built-in read; image content block returned).
- If not capable → run the read through a **configured** vision-capable model (explicit
  provider+model in `hashline-settings.json`, no auto-picking) to produce a **detailed textual
  image description**, and return that text to the session model (no image block, so the
  provider never chokes).

## Key findings (verified against installed packages)

1. **Model capability flag.** `Model.input: ("text" | "image")[]` is the canonical signal.
   Custom provider models (commandcode, models.json, models-store) all populate it — e.g.
   `deepseek/deepseek-v4-flash` → `["text"]`, `gpt-5.6-sol` → `["text","image"]`.
   The commandcode provider maintains an explicit allowlist (`MODEL_INPUT_MODALITIES` in
   `pi-commandcode-provider/src/models.ts`) and the pi-commandcode `assertTextOnlyMessages`
   throws for non-image models when image content is present. So the flag is authoritative and
   already used by providers.

2. **`ctx.model` is available to extension tools.** `ToolDefinition.execute` receives
   `ctx: ExtensionContext` as the 5th arg, and `ExtensionContext.model` is a live getter
   returning the current session model (`runner.createContext()` → `getModel()` →
   `agent.state.model`). Note: `createReadTool()` (the `AgentTool` wrapper) drops `ctx` —
   its `execute` arity is 4 and `ctxFactory` is undefined — so the built-in's
   `getNonVisionImageNote` never fires in the hashline path. **The hashline `read` override must
   read `ctx.model` itself.**

3. **Nested model calls: use `ctx.modelRegistry.complete()`.** This is the canonical API for
   extensions (the pi `summarize.ts` example calls `ctx.modelRegistry.complete(model,
   { messages }, { reasoningEffort, cacheRetention, sessionId })`). Verified in the running
   pi 0.84.1:
   - `ExtensionContext.modelRegistry: ModelRegistry` and
     `ModelRegistry.complete<TApi>(model, context, options?): Promise<AssistantMessage>`.
   - `complete` is fully auth-aware: `ModelRuntime.prepareRequest()` resolves OAuth credentials
     (with refresh), API keys, and headers for **any registered provider** — including
     commandcode's custom `streamSimple`. So no manual `getEnvApiKey`/pi-ai import hacks and no
     cross-provider keys needed. Auth failures surface as `ModelsError("auth", ...)` — we catch
     and degrade.
   - To find the fallback model: `ctx.modelRegistry.find(provider, modelId) → Model | undefined`
     (also `getAvailable()` / `hasConfiguredAuth()` if we want to verify usability).

4. **Image content format.** Built-in read returns `{ type: "image", data: <base64>, mimeType }`.
   `Context.messages` accepts `UserMessage` with `content: string | (TextContent | ImageContent)[]`
   where `ImageContent = { type: "image", data, mimeType }` — so pass the image block straight
   through, no re-encoding needed. Options accept `signal`, `maxTokens` (from `StreamOptions`).

5. **`read` flow.** hashline `read.ts` delegates to `createReadTool(ctx.cwd)` — the built-in
   read. For images it returns text `"Read image file [image/png]"` plus the image block. The
   override can detect the image block in the delegate result and replace it.

## Design

### New file: `hashline-settings.json` (config-driven fallback, no auto-pick)

Location: next to the extension is not ideal (extension dir is a workspace); put it in the
agent config dir alongside the other hashline state. hashline already persists snapshots —
check `store.ts` for where it writes (agent dir). Simplest robust choice: read from
`~/.pi/agent/hashline-settings.json` (agent dir), with graceful fallback to a default.

```json
{
  "visionFallback": {
    "provider": "commandcode",
    "model": "Qwen/Qwen3.7-Flash"
  }
}
```

Default (used when the file is missing or `visionFallback` absent): the above values — i.e.
commandcode + `Qwen/Qwen3.7-Flash` (verified present in `commandcode-models.json` and listed
as `["text", "image"]` in the commandcode provider's `MODEL_INPUT_MODALITIES`).

Behavior:
- If `visionFallback` is missing entirely → no fallback; image read on a non-vision model
  drops the image block with a text note (never hard-error).
- Resolve the model via `ctx.modelRegistry.find(provider, model)`. If not found, or the
  provider has no configured auth (`hasConfiguredAuth` false), or the call fails → drop the
  image block with a text note including the reason. No silent auto-picking of other models.

### New module: `vision.ts` (in hashline-tools)

```ts
import type { ExtensionContext, Model } from "@earendil-works/pi-coding-agent"; // Model via pi-ai re-export

export function isVisionCapable(model: ExtensionContext["model"]): boolean {
  return !!model && Array.isArray(model.input) && model.input.includes("image");
}

/** Load hashline-settings.json; returns { provider, model } or undefined. */
export function loadVisionFallbackConfig(): { provider: string; model: string } | undefined;

/** Resolve the configured fallback Model, or undefined if missing/unconfigured. */
export function resolveVisionFallbackModel(ctx: ExtensionContext): Model | undefined {
  const cfg = loadVisionFallbackConfig();
  if (!cfg) return undefined;
  const model = ctx.modelRegistry.find(cfg.provider, cfg.model);
  if (!model) return undefined;
  return isVisionCapable(model) ? model : undefined; // guard: configured model must be vision-capable
}

/** Describe the image via the fallback model. Throws on failure. */
export async function describeImage(
  image: { data: string; mimeType: string },
  visionModel: Model,
  ctx: ExtensionContext,
): Promise<string> {
  const result = await ctx.modelRegistry.complete(visionModel, {
    systemPrompt: "You are an image description service. Describe the image in detail...",
    messages: [
      {
        role: "user",
        timestamp: Date.now(),
        content: [
          { type: "text", text: "Describe this image in detail, including text/labels, layout, colors, and anything notable." },
          { type: "image", data: image.data, mimeType: image.mimeType },
        ],
      },
    ],
  }, { maxTokens: 800, signal: ctx.signal });
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}
```

### Changes to `read.ts` (hashline override)

- Widen the `ctx` param type from `{ cwd: string }` to `ExtensionContext` (import the type).
- Replace the delegate construction: `createReadTool(ctx.cwd)` → `createReadToolDefinition(ctx.cwd)`
  so the delegate's `execute` accepts the 5th `ctx` arg (needed anyway for correctness, and lets
  the built-in's resize logic keep working).
- In the image branch (`IMAGE_MAGIC` match), after `delegate.execute(...)`:

```ts
const result = await delegate.execute(toolCallId, { path: rawPath, offset, limit } as never, signal, onUpdate as never, ctx);
const model = ctx.model;
if (isVisionCapable(model)) {
  return result; // today's behavior
}
const imageBlock = result.content.find((c) => c.type === "image");
if (!imageBlock) {
  return result; // not an image result; leave as-is
}
const visionModel = resolveVisionFallbackModel(ctx);
if (!visionModel) {
  return { ...result, content: result.content.filter((c) => c.type !== "image") };
}
let description: string;
try {
  description = await describeImage(imageBlock, visionModel, ctx);
} catch (err) {
  // Fallback model failed — degrade to text-only read, note the reason.
  return { ...result, content: [
    { type: "text", text: `${textPart}\n[Vision fallback (${visionModel.id}) failed: ${msg}]` },
  ] };
}
return { ...result, content: [
  { type: "text", text: `Read image file [${imageBlock.mimeType}]\n\n[Described by ${visionModel.provider}/${visionModel.id}]\n\n${description}` },
] };
```

Notes:
- The `read.ts` `executeRead` currently takes `onUpdate: unknown` — keep that, cast as today.
- The non-image, non-`IMAGE_MAGIC` paths (`!st.isFile()`, oversized, NUL-containing) stay
  unchanged; they never produce image blocks.
- No recursion: `describeImage` is a raw registry call, not a tool call.

### Config details

- File: `~/.pi/agent/hashline-settings.json` (agent dir — resolve the same way store.ts
  resolves its dir; see `store.ts` for the pattern).
- Schema: `{ "visionFallback": { "provider": string, "model": string } }`.
- Unknown keys ignored. Malformed JSON → treated as unset (log/ignore).
- Kill switch: `PI_HASHLINE_VISION_DISABLE=1` env var bypasses the fallback entirely
  (consistent with existing `PI_HASHLINE_DISABLE` / `PI_PRUNE_DISABLE` switches in index.ts).

## Alternatives considered

- **A. Fix the built-in read note** (`getNonVisionImageNote`): would avoid the error but still
  gives no description — fails the "return a detailed image description" goal. Also can't fix
  the dead-code ctx plumbing from an extension. Rejected.
- **B. Auto-pick a vision model** from `modelRegistry.getAvailable()`: rejected per user
  direction — fallback provider/model must be explicit in config.
- **C. Call `pi-ai`'s `completeSimple` directly** with a hardcoded OpenRouter model: auth
  plumbing is manual and commandcode (the actual default provider) isn't a built-in pi-ai
  provider. `ctx.modelRegistry.complete` handles all providers uniformly. Rejected.
- **D. `resizeImage` before sending to the vision model**: nice-to-have; the built-in read
  already auto-resizes (`autoResizeImages` default true), so usually already handled.

## Risks / open questions

- **OAuth refresh for commandcode during the nested call.** `ModelRegistry.complete` resolves
  auth (including OAuth refresh) — the same path the main session uses, so it should just work.
  If the token is expired and refresh fails, `complete` rejects with `ModelsError("auth", ...)`;
  we catch and degrade to a text note. Verify with a smoke test.
- **Commandcode `/generate` semantics for a one-shot image request.** The commandcode stream
  uses thread semantics; a single `complete` call creates its own thread. Should be fine, but
  verify the image actually round-trips (the provider's `converters.ts` has
  `imageToCommandCode` with `data:${mimeType};base64,${data}` — image support is implemented).
- **Latency/cost.** Every image read on a text-only model costs one extra vision call.
  Acceptable; the fallback model is explicit/configurable.
- **`ctx.model` may be undefined** (no model selected yet in some contexts). In that case
  `isVisionCapable(undefined)` → false; but with no model we also can't know the session is
  text-only. Safe choice: if `ctx.model` is undefined, keep the current behavior (pass image
  through) — or treat as non-vision and use the fallback. Recommend: **treat undefined as
  non-vision + use fallback** only when a fallback is configured; otherwise pass through.
  (Decide during implementation; default = pass through to preserve today's behavior when
  no fallback is configured.)
- **Settings file location.** Confirm the agent-dir resolution pattern used by `store.ts`
  before implementing (avoid hardcoding `~/.pi/agent`).

## Implementation order

1. Check `store.ts` for the agent-dir/state-file resolution pattern; add
   `hashline-settings.json` loading (default = commandcode + `Qwen/Qwen3.7-Flash`).
2. Add `vision.ts` (`isVisionCapable` / `loadVisionFallbackConfig` /
   `resolveVisionFallbackModel` / `describeImage`).
3. Modify `read.ts`: widen ctx type, switch delegate to `createReadToolDefinition`, thread ctx,
   add the vision-fallback branch (vision → as-is; non-vision + fallback → describe; non-vision
   no fallback / failure → text-only with note).
4. Smoke test: with `deepseek/deepseek-v4-flash` (text-only) reading a PNG → expect a text
   description, no error; with a vision model → identical behavior to today; with
   `PI_HASHLINE_VISION_DISABLE=1` → image block passes through (or drops, per kill-switch
   semantics) without error.
5. Consider a `prune.test.ts`-style unit test for `isVisionCapable` /
   `resolveVisionFallbackModel` with a fake registry (matches existing test style).
