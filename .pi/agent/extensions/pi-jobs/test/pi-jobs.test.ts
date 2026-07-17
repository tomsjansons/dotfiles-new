import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";

import extension from "../src/index.ts";

function setup() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  let activeTools = ["read", "bash", "write"];
  const handlers = new Map<string, any[]>();
  const messages: any[] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const pi: any = {
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    getActiveTools() { return [...activeTools]; },
    setActiveTools(names: string[]) { activeTools = [...names]; },
    on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    sendMessage(message: any, options: any) { messages.push({ message, options }); },
  };
  extension(pi);
  const sessionId = `pi-jobs-test-${crypto.randomUUID()}`;
  const ctx: any = {
    cwd: process.cwd(),
    mode: "tui",
    hasUI: true,
    ui: { notify(message: string, level: string) { notifications.push({ message, level }); } },
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => `/tmp/2026-07-17T00-00-00-000Z_${sessionId}.jsonl`,
    },
  };
  return { tools, commands, handlers, messages, notifications, ctx, getActiveTools: () => [...activeTools] };
}

test("registers exactly the shared three-tool job surface", () => {
  const { tools } = setup();
  assert.deepEqual([...tools.keys()].sort(), ["job", "job_list", "job_stop"]);
});

test("disables bash on session start and exposes /bash-tool on|off", async () => {
  const { commands, handlers, notifications, ctx, getActiveTools } = setup();
  for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
  assert.equal(getActiveTools().includes("bash"), false);

  const command = commands.get("bash-tool");
  assert.ok(command);
  await command.handler("on", ctx);
  assert.equal(getActiveTools().includes("bash"), true);
  await command.handler("off", ctx);
  assert.equal(getActiveTools().includes("bash"), false);
  await command.handler("invalid", ctx);
  assert.deepEqual(notifications.at(-1), { message: "Usage: /bash-tool on|off", level: "warning" });
});

test("outer job tool runs JavaScript and job_list sees terminal history", async () => {
  const { tools, ctx } = setup();
  const job = tools.get("job");
  const list = tools.get("job_list");
  const result = await job.execute("tool-1", { type: "js", cmd: "return { ok: true }", mode: "sync" }, undefined, undefined, ctx);
  const details = result.details.job;
  try {
    assert.equal(details.status, "completed");
    assert.match(result.content[0].text, /ok: true/);
    const history = await list.execute("tool-2", { include: "non-running" }, undefined, undefined, ctx);
    assert.ok(history.details.list.nonRunning.some((entry: any) => entry.id === details.id));
  } finally {
    await rm(details.artifactDir, { recursive: true, force: true });
  }
});
