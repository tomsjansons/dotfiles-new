import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";

import extension from "../src/index.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

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

const theme = { fg: (_color: string, text: string) => text };

function completedJob(type: "js" | "bash" = "js") {
  return {
    id: `job-${type}`,
    type,
    mode: "sync",
    status: "completed",
    cwd: "/tmp/project",
    sessionId: "session",
    rootJobId: `job-${type}`,
    artifactDir: `/tmp/job-${type}`,
    outputPath: `/tmp/job-${type}/output`,
    startedAt: "2026-07-17T00:00:00.000Z",
    endedAt: "2026-07-17T00:00:01.000Z",
    durationMs: 1_000,
  };
}

test("renders job tools as compact self-shell rows", () => {
  const { tools } = setup();
  const job = tools.get("job");
  assert.equal(job.renderShell, "self");
  assert.deepEqual(job.renderCall({ type: "js", cmd: "return 1" }, theme, { isPartial: false }).render(120), []);

  const component = job.renderResult(
    { details: { operation: "job", job: completedJob("js") } },
    { isPartial: false },
    theme,
    { args: { type: "js", mode: "sync", cmd: "return 1" }, isError: false },
  );
  const lines = component.render(120);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /✓ .*js\/sync job-js completed 1\.0s/);
  assert.doesNotMatch(lines[0], /return 1/);
});

test("/job-details on|off toggles full JavaScript and bash commands", async () => {
  const { tools, commands, notifications, ctx } = setup();
  const job = tools.get("job");
  const command = commands.get("job-details");
  assert.ok(command);

  await command.handler("on", ctx);
  for (const [type, cmd] of [["js", "const value = 1;\nreturn value"], ["bash", "printf 'bash details\\n'"]] as const) {
    const component = job.renderResult(
      { details: { operation: "job", job: completedJob(type) } },
      { isPartial: false },
      theme,
      { args: { type, mode: "sync", cmd }, isError: false },
    );
    const rendered = component.render(40).join("\n");
    for (const line of cmd.split("\n")) assert.match(rendered, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.ok(component.render(40).every((line: string) => visibleWidth(line) <= 40));
  }

  await command.handler("off", ctx);
  const hidden = job.renderResult(
    { details: { operation: "job", job: completedJob("bash") } },
    { isPartial: false },
    theme,
    { args: { type: "bash", mode: "sync", cmd: "printf hidden" }, isError: false },
  ).render(120).join("\n");
  assert.doesNotMatch(hidden, /printf hidden/);

  await command.handler("invalid", ctx);
  assert.deepEqual(notifications.at(-1), { message: "Usage: /job-details on|off", level: "warning" });
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
