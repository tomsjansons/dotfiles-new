/**
 * Pruner unit test: simulates the `context` event with a message list and
 * verifies the opencode jump semantics (incl. image protection and the
 * two-recent-turns guard).
 */
import { registerPruner } from "./prune";

interface CtxMessage {
	role: string;
	toolName?: string;
	content?: unknown[];
	isError?: boolean;
}

const tr = (tokens: number, tool = "read", isError = false): CtxMessage => ({
	role: "toolResult",
	toolName: tool,
	isError,
	content: [{ type: "text", text: "x".repeat(tokens * 4) }], // estimate = chars/4
});

const img = (kb: number): CtxMessage => ({
	role: "toolResult",
	toolName: "read",
	content: [
		{ type: "text", text: "[shot.png#ABCD]" },
		{ type: "image", data: "A".repeat(kb * 1024), mimeType: "image/png" },
	],
});

const user = (): CtxMessage => ({ role: "user", content: [] });

// Fake ExtensionAPI that only uses pi.on
const handlers: Record<string, (event: any, ctx: any) => Promise<any>> = {};
const fakePi: any = {
	on: (event: string, handler: any) => {
		handlers[event] = handler;
	},
};

registerPruner(fakePi);

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
	if (!cond) {
		failures++;
		console.log(`FAIL ${name}`, extra ?? "");
	} else console.log(`ok   ${name}`);
}

// Case 1: below protect (40k) within prunable turns → nothing pruned
{
	// turn 3 (oldest, prunable side) holds only 10k of tool output
	const ev = { messages: [user(), tr(2000, "bash"), tr(2000), tr(2000), tr(2000), tr(2000), user(), tr(100), user()] };
	const out = await handlers["context"](ev, {});
	check("below protect: no prune", out === undefined);
	check(
		"all content intact",
		ev.messages.every((m) => m.role === "user" || m.content?.[0]?.type === "text"),
	);
}

// Case 2: enough old tool output (>PRUNE_MINIMUM backlog beyond 40k) → old stubbed
{
	const messages: CtxMessage[] = [user()];
	for (let i = 0; i < 60; i++) messages.push({ role: "toolResult", toolName: "read", content: [{ type: "text", text: "y".repeat(4000) }] }); // 1000 tokens each = 60k
	messages.push(user());
	messages.push(tr(4000)); // recent turn: protected
	messages.push(user());
	const ev = { messages };
	const out = await handlers["context"](ev, {});
	// walk from newest: user(turn1) → recent 4k skipped (turns<2) → user(turn2) →
	// 60k counted → 40k protected → 20k prunable → jump needs > 20k… borderline,
	// so the stubs are the oldest ~20k; verify some pruned and recent survives.
	const pruned = out.messages.filter((m: any) => m.content?.[0]?.text === "[Old tool result content cleared]").length;
	check("jump prune fires with >20k backlog", pruned > 0, `pruned=${pruned}`);
	check("newest result survives", out.messages[62]?.content?.[0]?.text === "y".repeat(16000) || out.messages.at(-2)?.content?.[0]?.text !== "[Old tool result content cleared]");
}

// Case 3: PI_PRUNE_DISABLE kills it
{
	process.env.PI_PRUNE_DISABLE = "1";
	const messages: CtxMessage[] = [];
	for (let i = 0; i < 100; i++) messages.push({ role: "toolResult", toolName: "read", content: [{ type: "text", text: "y".repeat(4000) }] });
	const out = await handlers["context"]({ messages }, {});
	delete process.env.PI_PRUNE_DISABLE;
	check("kill switch honored", out === undefined || out.messages === messages);
}

// Case 4: image-bearing tool results are never pruned, even when a jump fires
{
	// 80k text backlog in the oldest turn → jump fires under the new rules too,
	// but the image (old code: ~131k est. tokens, first against the wall) survives.
	const messages: CtxMessage[] = [user(), img(500)];
	for (let i = 0; i < 80; i++) messages.push(tr(1000));
	messages.push(user(), tr(100), user());
	const ev = { messages };
	const out = await handlers["context"](ev, {});
	const pruned = out.messages.filter((m: any) => m.content?.[0]?.text === "[Old tool result content cleared]").length;
	check("jump fired alongside image", pruned > 0, `pruned=${pruned}`);
	const imgMsg = out.messages[1];
	check(
		"old image result survives the jump",
		imgMsg.content?.some((c: any) => c.type === "image") === true && imgMsg.content?.[0]?.text === "[shot.png#ABCD]",
		JSON.stringify(imgMsg.content?.map((c: any) => c.type)),
	);
}

// Case 5: images don't count toward totals — a single big screenshot can't
// trigger a jump or consume the protect window
{
	// one huge image read (~131k est. tokens if counted — enough to fire a jump
	// under the old rules) + nothing else prunable
	const messages: CtxMessage[] = [user(), img(512), user(), tr(100), user()];
	const ev = { messages };
	const out = await handlers["context"](ev, {});
	check("image-only backlog: no prune", out === undefined);
}

// Case 6: fewer than two user turns → nothing is ever pruned
{
	const messages: CtxMessage[] = [user()];
	for (let i = 0; i < 100; i++) messages.push(tr(1000)); // 100k backlog, single turn
	const ev = { messages };
	const out = await handlers["context"](ev, {});
	check("single turn: no prune", out === undefined);
}

// Case 7: the two most recent user turns are protected even with a huge backlog
{
	const messages: CtxMessage[] = [user(), tr(2000), user(), tr(30000), user()]; // 30k tokens in current turn
	const ev = { messages };
	const out = await handlers["context"](ev, {});
	check("recent turns untouched", out === undefined);
}

console.log(failures === 0 ? "\nPRUNER ALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
