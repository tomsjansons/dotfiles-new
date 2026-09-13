/**
 * Jump pruner: opencode-style age-based pruning of old tool results,
 * implemented as a send-time transform on the `context` event.
 *
 * Semantics (port of opencode's SessionCompaction.prune):
 * - nothing inside the two most recent user turns is ever touched
 *   (upstream's `turns < 2` guard — pruning only reaches past history)
 * - walk messages newest → oldest, accumulating estimated tool-result tokens
 * - the most recent PRUNE_PROTECT tokens of tool output are untouchable
 * - everything older is prunable, but the transform only applies once the
 *   prunable backlog exceeds PRUNE_MINIMUM — pruning happens in JUMPS
 * - tool results containing image blocks are never pruned and never counted:
 *   upstream estimates only the text `state.output` (attachments excluded), and
 *   stubbing an image the model is still reasoning about is the exact failure
 *   mode pruning must not create — models would report "images cleared from
 *   context". Base64 in `content` would also let a single screenshot trigger a
 *   jump on its own, wiping the image (and older text) almost immediately.
 * - a pruned result keeps its message/part structure; only the body becomes
 *   a placeholder (attachments dropped)
 *
 * Why send-time (not mutation): pi's `context` event hands us a deep copy, so
 * the on-disk session keeps full content for resume/audit. The transform is a
 * pure function of the (append-only) history, so its output is byte-stable
 * between frontier jumps — the prompt cache invalidates once per jump and
 * rides warm in between, same economics as opencode's persistent version.
 *
 * Deliberately NOT tag-aware: the snapshot store owns correctness (stale tags
 * deny/recover), this module owns token hygiene. An invariant like "context
 * never holds an unresolvable tag" cannot coexist with jump pruning, and jump
 * pruning wins.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PRUNE_PROTECT = 40_000; // tokens of recent tool output always kept
const PRUNE_MINIMUM = 20_000; // min prunable backlog before a jump fires
const MIN_PART_TOKENS = 500; // don't stub tiny results — noise without savings

const PLACEHOLDER = "[Old tool result content cleared]";

interface TextContent {
	type: "text";
	text: string;
}
interface ToolResultMessage {
	role: string;
	toolName?: string;
	content?: unknown;
	isError?: boolean;
}

/** Rough token estimate: chars/4 over the JSON of the content blocks. */
function estimate(content: unknown): number {
	try {
		return Math.ceil(JSON.stringify(content).length / 4);
	} catch {
		return 0;
	}
}

/** Image blocks must survive pruning; their base64 must not inflate the estimate. */
function hasImage(content: unknown[]): boolean {
	return content.some((c) => (c as { type?: string } | null)?.type === "image");
}

export function registerPruner(pi: ExtensionAPI): void {
	pi.on("context", async (event) => {
		if (process.env.PI_PRUNE_DISABLE) return;
		const messages = event.messages as unknown as ToolResultMessage[];

		let total = 0;
		let prunable = 0;
		let turns = 0;
		const toPrune: ToolResultMessage[] = [];
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.role === "user") {
				turns++;
				continue;
			}
			if (turns < 2) continue; // current + previous user turn are untouchable
			if (m.role !== "toolResult" || !Array.isArray(m.content)) continue;
			if (hasImage(m.content)) continue; // images: never pruned, never counted
			const size = estimate(m.content);
			total += size;
			if (total <= PRUNE_PROTECT) continue;
			if (size < MIN_PART_TOKENS) continue;
			prunable += size;
			toPrune.push(m);
		}
		if (prunable <= PRUNE_MINIMUM) return;

		for (const m of toPrune) {
			m.content = [{ type: "text", text: PLACEHOLDER } satisfies TextContent];
		}
		return { messages: event.messages };
	});
}
