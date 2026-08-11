/**
 * Pruner unit test: simulates the `context` event with a message list and
 * verifies the opencode jump semantics.
 */
import { registerPruner } from "./prune";

interface CtxMessage {
	role: string;
	toolName?: string;
	content?: unknown[];
	isError?: boolean;
}

function makeMessages(): { messages: CtxMessage[] } {
	const mk = (tokens: number, tool = "read", isError = false): CtxMessage => ({
		role: "toolResult",
		toolName: tool,
		isError,
		content: [{ type: "text", text: "x".repeat(tokens * 4) }], // estimate = chars/4
	});
	return {
		messages: [
			mk(2000, "bash"),
			mk(2000, "read"), // deep history
			mk(2000, "read"),
			mk(2000, "read"),
			mk(2000, "read"), // these are within PRUNE_PROTECT 40k? 10k total → all protected
		],
	};
}

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

// Case 1: total tool output below PRUNE_PROTECT (40k) → nothing pruned
{
	const ev = makeMessages();
	const out = await handlers["context"](ev, {});
	check("below protect: no prune", out === undefined || out.messages === ev.messages);
	check("all content intact", ev.messages.every((m) => m.content?.[0]?.type === "text"));
}

// Case 2: enough old tool output (>PRUNE_MINIMUM backlog beyond 40k) → old stubbed
{
	const messages: CtxMessage[] = [];
	for (let i = 0; i < 60; i++) messages.push({ role: "toolResult", toolName: "read", content: [{ type: "text", text: "y".repeat(4000) }] }); // 1000 tokens each = 60k
	messages.push({ role: "toolResult", toolName: "read", content: [{ type: "text", text: "z".repeat(16000) }] }); // 4k tokens recent
	messages.push({ role: "user", content: [] });
	const ev = { messages };
	const out = await handlers["context"](ev, {});
	// walk from newest: 4k recent + up to 40k protected; beyond → 24k prunable > 20k minimum → stub the old ones
	const pruned = out.messages.filter((m: any) => m.content?.[0]?.text === "[Old tool result content cleared]").length;
	check("jump prune fires with >20k backlog", pruned >= 20, `pruned=${pruned}`);
	check("newest result survives", out.messages.at(-2)?.content?.[0]?.text === "z".repeat(16000));
}

// Case 3: PI_PRUNE_DISABLE kills it
{
	process.env.PI_PRUNE_DISABLE = "1";
	const ev = makeMessages();
	// even a huge backlog must not prune
	const messages: CtxMessage[] = [];
	for (let i = 0; i < 100; i++) messages.push({ role: "toolResult", toolName: "read", content: [{ type: "text", text: "y".repeat(4000) }] });
	const out = await handlers["context"]({ messages }, {});
	delete process.env.PI_PRUNE_DISABLE;
	check("kill switch honored", out === undefined || out.messages === messages);
}

console.log(failures === 0 ? "\nPRUNER ALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
