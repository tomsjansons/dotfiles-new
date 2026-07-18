import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JobManager } from "@dotfiles/job-runtime";
import { visibleWidth } from "@earendil-works/pi-tui";
import extension, * as extensionModule from "../src/index.ts";

function setup(platform: () => NodeJS.Platform = () => "linux", recoveryArtifactRoot?: string) {
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
  const testId = crypto.randomUUID();
  const manager = new JobManager();
  extension(pi, platform, {
    manager,
    recovery: { artifactRoot: recoveryArtifactRoot ?? join(tmpdir(), `pi-jobs-empty-recovery-${testId}`) },
  });
  const sessionId = `pi-jobs-test-${testId}`;
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
  return { tools, commands, handlers, manager, messages, notifications, ctx, getActiveTools: () => [...activeTools] };
}

test("single extension module composes the complete pi-jobs interface", () => {
  const { tools, commands, handlers } = setup();
  assert.deepEqual(Object.keys(extensionModule), ["default"]);
  assert.deepEqual([...tools.keys()].sort(), ["job", "job_list", "job_stop"]);
  assert.deepEqual([...commands.keys()].sort(), ["bash-tool", "job-details"]);
  assert.equal(handlers.get("session_start")?.length, 1);
  assert.equal(handlers.get("session_shutdown")?.length, 1);
});

test("unsupported platforms expose no job surface, preserve bash, and diagnose once", async () => {
  const { tools, commands, handlers, manager, notifications, ctx, getActiveTools } = setup(() => "darwin");

  assert.equal(manager.providers.get("js"), undefined);
  assert.deepEqual([...tools.keys()], []);
  assert.deepEqual([...commands.keys()], []);
  assert.deepEqual(getActiveTools(), ["read", "bash", "write"]);
  assert.equal(handlers.get("session_start")?.length, 1);
  assert.equal(handlers.has("session_shutdown"), false);

  const startup = handlers.get("session_start")![0];
  await startup({ reason: "startup" }, ctx);
  await startup({ reason: "startup" }, ctx);
  assert.deepEqual(notifications, [{
    message: "Managed job tools are unavailable on darwin: pi-jobs supports Linux only. The standalone bash tool remains active.",
    level: "error",
  }]);
  assert.deepEqual(getActiveTools(), ["read", "bash", "write"]);
});

test("fresh session startup finalizes stale records without delivering them", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-jobs-startup-recovery-"));
  const artifactDir = join(root, "cwd", "session", "stale-job");
  await mkdir(artifactDir, { recursive: true });
  await writeFile(join(artifactDir, "manifest.json"), `${JSON.stringify({
    id: "stale-job",
    type: "js",
    mode: "async",
    status: "starting",
    cwd: "/tmp",
    sessionId: "crashed-session",
    rootJobId: "stale-job",
    artifactDir,
    outputPath: join(artifactDir, "output.yaml"),
    startedAt: "2026-01-01T00:00:00.000Z",
    hostProcess: { pid: process.pid, startTimeTicks: "not-this-process" },
    deliveryState: "pending",
  })}\n`);
  const { handlers, messages, notifications, ctx } = setup(() => "linux", root);

  try {
    await handlers.get("session_start")![0]({ reason: "startup" }, ctx);
    const manifest = JSON.parse(await readFile(join(artifactDir, "manifest.json"), "utf8"));
    assert.equal(manifest.status, "failed");
    assert.equal(manifest.stopReason, "host_crashed");
    assert.equal(manifest.deliveryState, "none");
    assert.deepEqual(messages, []);
    assert.deepEqual(notifications, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("renders one visible row while a job has a partial result", () => {
  const { tools } = setup();
  const jobTool = tools.get("job");
  const args = { type: "bash", mode: "sync", cmd: "sleep 10" };
  const running = {
    ...completedJob("bash"),
    status: "running",
    endedAt: undefined,
    durationMs: undefined,
  };
  const context = { args, executionStarted: true, isError: false, isPartial: true, state: {} };

  const callComponent = jobTool.renderCall(args, theme, context);
  assert.equal(callComponent.render(120).filter((line: string) => line.trim() !== "").length, 1);
  const resultComponent = jobTool.renderResult(
    {
      content: [{ type: "text", text: "bash job job-bash: running (1.0s)" }],
      details: { operation: "job", job: running },
    },
    { isPartial: true },
    theme,
    context,
  );

  const visibleLines = [...callComponent.render(120), ...resultComponent.render(120)].filter((line) => line.trim() !== "");
  assert.equal(visibleLines.length, 1);
  assert.match(visibleLines[0], /bash\/sync job-bash running/);
});

test("job detail rendering respects tiny widths on every tool render path", async () => {
  const { tools, commands, ctx } = setup();
  await commands.get("job-details").handler("on", ctx);

  const ansiTheme = { fg: (_color: string, text: string) => `\x1b[35m${text}\x1b[0m` };
  const detailCommands = ["", "first\n\nlast", "abcdefghijklmnopqrstuvwxyz", "\x1b[31m界 ansi command text\x1b[0m"];
  const components: any[] = [];
  for (const cmd of detailCommands) {
    components.push(
      tools.get("job").renderCall({ type: "js", mode: "sync", cmd }, ansiTheme, { isPartial: true }),
      tools.get("job").renderResult(
        { details: { operation: "job", job: completedJob("js") } },
        { isPartial: false },
        ansiTheme,
        { args: { type: "js", mode: "sync", cmd }, isError: false },
      ),
      tools.get("job").renderResult(
        { content: [{ type: "text", text: "failed visibly" }] },
        { isPartial: false },
        ansiTheme,
        { args: { type: "js", mode: "sync", cmd }, isError: true },
      ),
    );
  }
  components.push(
    tools.get("job_list").renderCall({}, ansiTheme, { isPartial: true }),
    tools.get("job_list").renderResult(
      { details: { operation: "job_list", list: { running: [], nonRunning: [], nonRunningCount: 0 } } },
      { isPartial: false },
      ansiTheme,
      { isError: false },
    ),
    tools.get("job_stop").renderCall({ id: "job-js" }, ansiTheme, { isPartial: true }),
    tools.get("job_stop").renderResult(
      { details: { operation: "job_stop", job: completedJob("js") } },
      { isPartial: false },
      ansiTheme,
      { isError: false },
    ),
  );

  for (let width = 1; width <= 6; width += 1) {
    for (const component of components) {
      for (const line of component.render(width)) {
        assert.ok(visibleWidth(line) <= width, `width ${width} rendered ${visibleWidth(line)} columns: ${JSON.stringify(line)}`);
      }
    }
  }

  const longCommand = "preserve-the-whole-command";
  const longDetails = tools.get("job").renderResult(
    { details: { operation: "job", job: completedJob("bash") } },
    { isPartial: false },
    theme,
    { args: { type: "bash", mode: "sync", cmd: longCommand }, isError: false },
  );
  for (let width = 1; width <= 6; width += 1) {
    const displayedCommand = longDetails.render(width).slice(1).map((line: string) => line.trimStart()).join("");
    assert.equal(displayedCommand, longCommand);
  }

  const ansiCommand = "\x1b[31m界ansi\x1b[0m";
  const ansiDetails = tools.get("job").renderResult(
    { details: { operation: "job", job: completedJob("js") } },
    { isPartial: false },
    theme,
    { args: { type: "js", mode: "sync", cmd: ansiCommand }, isError: false },
  );
  for (let width = 2; width <= 6; width += 1) {
    const displayedCommand = ansiDetails.render(width).slice(1)
      .map((line: string) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trimStart())
      .join("");
    assert.equal(displayedCommand, "界ansi");
  }
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
