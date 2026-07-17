import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DefaultHerdrJobHost,
  discoverHerdr,
  UnixHerdrClient,
  type CreatedTab,
  type HerdrClient,
  type HerdrPane,
  type HerdrTab,
} from "../src/index.ts";

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
    return { type: "pong", version: "0.7.3", protocol: 16, capabilities: {} };
  });
  try {
    assert.deepEqual(await new UnixHerdrClient(fixture.socketPath).ping(), { version: "0.7.3", protocol: 16 });
  } finally {
    await fixture.close();
  }
});

test("discovery trusts the server pane workspace and tab", async () => {
  const fixture = await socketFixture((request) => {
    if (request.method === "ping") return { type: "pong", version: "0.7.3", protocol: 16 };
    if (request.method === "pane.get") return { type: "pane_info", pane: pane(request.params.pane_id, "tab-server") };
    throw new Error(`Unexpected method ${request.method}`);
  });
  try {
    const found = await discoverHerdr({ HERDR_ENV: "1", HERDR_SOCKET_PATH: fixture.socketPath, HERDR_PANE_ID: "pane-caller" });
    assert.equal(found?.workspaceId, "workspace-1");
    assert.equal(found?.tabId, "tab-server");
    assert.equal(found?.paneId, "pane-caller");
  } finally {
    await fixture.close();
  }
});

class FakeClient implements HerdrClient {
  tabs: HerdrTab[] = [];
  panes: HerdrPane[] = [];
  calls: Array<{ method: string; input: any }> = [];

  async ping() { return { version: "0.7.3", protocol: 16 }; }
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
    const found = this.panes.find((item) => item.pane_id === id);
    if (found) found.label = label;
  }
  async sendInput(id: string, text: string) {
    this.calls.push({ method: "sendInput", input: { id, text } });
    const requestPath = text.match(/'([^']+)'$/)?.[1];
    assert.ok(requestPath);
    const request = JSON.parse(await readFile(requestPath, "utf8"));
    await writeFile(request.outputPath, "from-herdr\n");
    await writeFile(request.resultPath, `${JSON.stringify({ exitCode: 0, signal: null })}\n`);
  }
  async closePane(id: string) {
    this.calls.push({ method: "closePane", input: { id } });
    this.panes = this.panes.filter((item) => item.pane_id !== id);
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
