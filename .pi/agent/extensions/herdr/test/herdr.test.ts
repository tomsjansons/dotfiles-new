import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  atomicJson,
  DefaultHerdrJobHost,
  discoverHerdr,
  UnixHerdrClient,
  type CreatedTab,
  type HerdrClient,
  type HerdrPane,
  type HerdrTab,
} from "../src/index.ts";

test("atomicJson atomically replaces JSON with mode 0600", async () => {
  const dir = await mkdtemp(join(tmpdir(), "herdr-atomic-json-"));
  const path = join(dir, "result.json");
  try {
    await writeFile(path, "old\n", { mode: 0o644 });
    const previous = await stat(path);

    await atomicJson(path, { status: "completed", secret: "owner-only" });

    const current = await stat(path);
    assert.notEqual(current.ino, previous.ino, "the destination should be replaced by rename");
    assert.equal(current.mode & 0o777, 0o600);
    assert.equal(await readFile(path, "utf8"), '{\n  "status": "completed",\n  "secret": "owner-only"\n}\n');
    assert.deepEqual(await readdir(dir), ["result.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const pane = (id: string, tabId = "tab-main", label?: string): HerdrPane => ({
  pane_id: id,
  terminal_id: `terminal-${id}`,
  workspace_id: "workspace-1",
  tab_id: tabId,
  focused: false,
  label,
  revision: 1,
});

async function socketFixture(handler: (request: any) => any) {
  const dir = await mkdtemp(join(tmpdir(), "herdr-client-"));
  const socketPath = join(dir, "herdr.sock");
  const server = createServer((socket) => {
    let text = "";
    socket.on("data", (chunk) => {
      text += chunk.toString("utf8");
      const newline = text.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(text.slice(0, newline));
      const response = `${JSON.stringify({ id: request.id, result: handler(request) })}\n`;
      const midpoint = Math.floor(response.length / 2);
      socket.write(response.slice(0, midpoint));
      setTimeout(() => socket.end(response.slice(midpoint)), 2);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("Unix client frames NDJSON and accepts partial responses", async () => {
  const fixture = await socketFixture((request) => {
    assert.equal(request.method, "ping");
    return {
      type: "pong",
      version: "0.7.3",
      protocol: 16,
      capabilities: { live_handoff: true, detached_server_daemon: true },
    };
  });
  try {
    assert.deepEqual(await new UnixHerdrClient(fixture.socketPath).ping(), {
      version: "0.7.3",
      protocol: 16,
      capabilities: { live_handoff: true, detached_server_daemon: true },
    });
  } finally {
    await fixture.close();
  }
});

test("discovery accepts Herdr 0.7.3's minimum managed-job capability", async () => {
  const fixture = await socketFixture((request) => {
    if (request.method === "ping") {
      return {
        type: "pong",
        version: "0.7.3",
        protocol: 16,
        capabilities: { live_handoff: false, detached_server_daemon: true },
      };
    }
    if (request.method === "pane.get") return { type: "pane_info", pane: pane(request.params.pane_id, "tab-server") };
    throw new Error(`Unexpected method ${request.method}`);
  });
  try {
    const found = await discoverHerdr({ HERDR_ENV: "1", HERDR_SOCKET_PATH: fixture.socketPath, HERDR_PANE_ID: "pane-caller" });
    assert.equal(found?.workspaceId, "workspace-1");
    assert.equal(found?.tabId, "tab-server");
    assert.equal(found?.paneId, "pane-caller");
    assert.deepEqual(found?.capabilities, { live_handoff: false, detached_server_daemon: true });
  } finally {
    await fixture.close();
  }
});

test("discovery rejects incompatible Herdr capability metadata", async () => {
  const fixture = await socketFixture((request) => {
    if (request.method === "ping") {
      return {
        type: "pong",
        version: "0.7.3",
        protocol: 16,
        capabilities: { live_handoff: true, detached_server_daemon: false },
      };
    }
    if (request.method === "pane.get") return { type: "pane_info", pane: pane(request.params.pane_id) };
    throw new Error(`Unexpected method ${request.method}`);
  });
  try {
    await assert.rejects(
      discoverHerdr({ HERDR_ENV: "1", HERDR_SOCKET_PATH: fixture.socketPath, HERDR_PANE_ID: "pane-caller" }),
      (error: any) => {
        assert.equal(error?.name, "HerdrDiscoveryError");
        assert.equal(error?.code, "ERR_HERDR_CAPABILITIES");
        assert.equal(error?.message, "Herdr capability detached_server_daemon is required for managed pane jobs");
        return true;
      },
    );
  } finally {
    await fixture.close();
  }
});

test("discovery rejects missing Herdr capability metadata", async () => {
  const fixture = await socketFixture((request) => {
    if (request.method === "ping") return { type: "pong", version: "0.7.3", protocol: 16 };
    if (request.method === "pane.get") return { type: "pane_info", pane: pane(request.params.pane_id) };
    throw new Error(`Unexpected method ${request.method}`);
  });
  try {
    await assert.rejects(
      discoverHerdr({ HERDR_ENV: "1", HERDR_SOCKET_PATH: fixture.socketPath, HERDR_PANE_ID: "pane-caller" }),
      (error: any) => error?.name === "HerdrDiscoveryError" && error?.code === "ERR_HERDR_CAPABILITIES",
    );
  } finally {
    await fixture.close();
  }
});

class FakeClient implements HerdrClient {
  tabs: HerdrTab[] = [];
  panes: HerdrPane[] = [];
  calls: Array<{ method: string; input: any }> = [];
  runOnSend = true;
  retainClosedPane = false;
  renameError?: Error;
  sendError?: Error;
  closeError?: Error;
  closeWait?: Promise<void>;
  request?: any;

  async ping() {
    return {
      version: "0.7.3",
      protocol: 16,
      capabilities: { live_handoff: true, detached_server_daemon: true },
    };
  }
  async getPane(id: string) { return this.panes.find((item) => item.pane_id === id)!; }
  async listTabs() { return this.tabs; }
  async listPanes() { return this.panes; }
  async createTab(input: any): Promise<CreatedTab> {
    this.calls.push({ method: "createTab", input });
    const tab: HerdrTab = { tab_id: "tab-shell", workspace_id: "workspace-1", number: 2, label: input.label, focused: false, pane_count: 1 };
    const root = pane("pane-root", tab.tab_id);
    this.tabs.push(tab);
    this.panes.push(root);
    return { tab, rootPane: root };
  }
  async splitPane(input: any) {
    this.calls.push({ method: "splitPane", input });
    const created = pane("pane-job", "tab-shell");
    this.panes.push(created);
    return created;
  }
  async renamePane(id: string, label: string) {
    this.calls.push({ method: "renamePane", input: { id, label } });
    if (id === "pane-job" && this.renameError) throw this.renameError;
    const found = this.panes.find((item) => item.pane_id === id);
    if (found) found.label = label;
  }
  async sendInput(id: string, text: string) {
    this.calls.push({ method: "sendInput", input: { id, text } });
    if (this.sendError) throw this.sendError;
    const requestPath = text.match(/'([^']+)'$/)?.[1];
    assert.ok(requestPath);
    this.request = JSON.parse(await readFile(requestPath, "utf8"));
    if (!this.runOnSend) return;
    await writeFile(this.request.outputPath, "from-herdr\n");
    await writeFile(this.request.resultPath, `${JSON.stringify({ exitCode: 0, signal: null })}\n`);
  }
  async closePane(id: string) {
    this.calls.push({ method: "closePane", input: { id } });
    await this.closeWait;
    if (this.closeError) throw this.closeError;
    if (!this.retainClosedPane) this.panes = this.panes.filter((item) => item.pane_id !== id);
  }
}

test("job host creates an unfocused pi-shell anchor and runs only in a split pane", async () => {
  const dir = await mkdtemp(join(tmpdir(), "herdr-host-"));
  const client = new FakeClient();
  const host = new DefaultHerdrJobHost(client, "workspace-1");
  try {
    const handle = await host.start({ id: "job-1", cmd: "printf ignored", cwd: dir, artifactDir: dir, outputPath: join(dir, "output.log") });
    const result = await handle.completion;
    assert.equal(result.status, "completed");
    assert.equal(result.outputText, "from-herdr\n");
    assert.deepEqual(client.calls.find((call) => call.method === "createTab")?.input, {
      workspaceId: "workspace-1", cwd: dir, label: "pi-shell", focus: false,
    });
    const split = client.calls.find((call) => call.method === "splitPane")?.input;
    assert.equal(split.targetPaneId, "pane-root");
    assert.equal(split.direction, "right");
    assert.equal(split.ratio, 0.5);
    assert.equal(split.focus, false);
    assert.equal(client.calls.filter((call) => call.method === "sendInput").length, 1);
    assert.equal(client.calls.find((call) => call.method === "sendInput")?.input.id, "pane-job");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("job host cleans only the allocated pane when marking it fails", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "herdr-host-mark-failure-"));
  const start = (client: FakeClient, id: string) => new DefaultHerdrJobHost(client, "workspace-1").start({
    id,
    cmd: "printf never-launched",
    cwd: dir,
    artifactDir: dir,
    outputPath: join(dir, `${id}.log`),
  });
  try {
    await t.test("closes the new pane and preserves the marking failure", async () => {
      const client = new FakeClient();
      const renameError = Object.assign(new Error("pane rename failed"), { code: "ERR_HERDR_RENAME" });
      client.renameError = renameError;

      await assert.rejects(start(client, "job-mark-failure"), (error) => error === renameError);

      assert.deepEqual(client.calls.filter((call) => call.method === "closePane").map((call) => call.input.id), ["pane-job"]);
      assert.deepEqual(client.panes.map((item) => item.pane_id), ["pane-root"], "the anchor must remain open");
      assert.equal(client.calls.some((call) => call.method === "sendInput"), false);
    });

    await t.test("attaches a failed cleanup without replacing the marking failure", async () => {
      const client = new FakeClient();
      const renameError = new Error("pane rename failed");
      const cleanupError = new Error("pane close failed");
      client.renameError = renameError;
      client.closeError = cleanupError;

      await assert.rejects(start(client, "job-cleanup-failure"), (error: any) => {
        assert.equal(error, renameError);
        assert.equal((error as any).cleanupError, cleanupError);
        assert.match((error as any).cleanupContext, /pane-job/);
        return true;
      });

      assert.deepEqual(client.calls.filter((call) => call.method === "closePane").map((call) => call.input.id), ["pane-job"]);
      assert.ok(client.panes.some((item) => item.pane_id === "pane-root"), "the anchor must remain open");
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("job host returns an explicit failure when transport fails after pane allocation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "herdr-host-launch-failure-"));
  const client = new FakeClient();
  client.sendError = Object.assign(new Error("socket disconnected during launch"), { code: "ERR_HERDR_TRANSPORT" });
  const host = new DefaultHerdrJobHost(client, "workspace-1");
  try {
    const handle = await host.start({ id: "job-launch-failure", cmd: "touch must-not-run", cwd: dir, artifactDir: dir, outputPath: join(dir, "output.log") });
    const result = await handle.completion;

    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "ERR_HERDR_TRANSPORT");
    assert.match(result.error?.message ?? "", /Failed to launch command in Herdr job pane/);
    assert.deepEqual(client.calls.filter((call) => call.method === "closePane").map((call) => call.input.id), ["pane-job"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("job host reports a pane close transport failure instead of stopped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "herdr-host-close-failure-"));
  const client = new FakeClient();
  client.runOnSend = false;
  client.closeError = Object.assign(new Error("socket disconnected during close"), { code: "ERR_HERDR_TRANSPORT" });
  const host = new DefaultHerdrJobHost(client, "workspace-1", "pi-shell", {
    pollMs: 2,
    paneCheckMs: 2,
    stopGraceMs: 20,
  });
  try {
    const handle = await host.start({ id: "job-close-failure", cmd: "sleep 10", cwd: dir, artifactDir: dir, outputPath: join(dir, "output.log") });
    await handle.stop("stopped");
    const result = await handle.completion;

    assert.equal(result.status, "failed");
    assert.equal(result.stopReason, "stopped");
    assert.equal(result.error?.code, "ERR_HERDR_TRANSPORT");
    assert.match(result.error?.message ?? "", /Failed to close Herdr job pane/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a concurrent runner result cannot hide a pending close failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "herdr-host-close-race-"));
  const client = new FakeClient();
  client.runOnSend = false;
  client.closeError = Object.assign(new Error("close request lost its transport"), { code: "ERR_HERDR_TRANSPORT" });
  let releaseClose!: () => void;
  client.closeWait = new Promise<void>((resolve) => { releaseClose = resolve; });
  const host = new DefaultHerdrJobHost(client, "workspace-1", "pi-shell", {
    pollMs: 1,
    paneCheckMs: 1,
    stopGraceMs: 10,
  });
  try {
    const handle = await host.start({ id: "job-close-race", cmd: "sleep 10", cwd: dir, artifactDir: dir, outputPath: join(dir, "output.log") });
    const stopping = handle.stop("stopped");
    assert.ok(client.request);
    await writeFile(client.request.resultPath, `${JSON.stringify({ exitCode: 0, signal: null })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 3));
    releaseClose();
    await stopping;

    const result = await handle.completion;
    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "ERR_HERDR_TRANSPORT");
  } finally {
    releaseClose?.();
    await rm(dir, { recursive: true, force: true });
  }
});

test("job host fails stop verification when the pane remains alive past grace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "herdr-host-stop-grace-"));
  const client = new FakeClient();
  client.runOnSend = false;
  client.retainClosedPane = true;
  const host = new DefaultHerdrJobHost(client, "workspace-1", "pi-shell", {
    pollMs: 2,
    paneCheckMs: 2,
    stopGraceMs: 20,
  });
  try {
    const handle = await host.start({ id: "job-still-alive", cmd: "sleep 10", cwd: dir, artifactDir: dir, outputPath: join(dir, "output.log") });
    await handle.stop("timeout");
    const result = await handle.completion;

    assert.equal(result.status, "failed");
    assert.equal(result.stopReason, "timeout");
    assert.equal(result.error?.code, "ERR_HERDR_STOP_UNVERIFIED");
    assert.ok(client.panes.some((item) => item.pane_id === "pane-job"), "the fake pane should still be alive");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
