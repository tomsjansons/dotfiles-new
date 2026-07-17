import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getGlobalJobManager, JavaScriptJobProvider, JobManager } from "@dotfiles/job-runtime";
import bashJobsExtension from "../src/extension.ts";
import { LocalBashJobProvider, RoutedBashJobProvider } from "../src/index.ts";

function context(label: string) {
  return {
    cwd: process.cwd(),
    sessionId: `bash-test-${label}-${crypto.randomUUID()}`,
    sessionTimestamp: new Date().toISOString(),
  };
}

function manager(withJavaScript = false): JobManager {
  const jobs = new JobManager();
  jobs.providers.register(new LocalBashJobProvider());
  if (withJavaScript) jobs.providers.register(new JavaScriptJobProvider());
  return jobs;
}

async function cleanup(...paths: string[]): Promise<void> {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
}

test("bash extension does not register its provider on unsupported platforms", () => {
  const handlers = new Map<string, any[]>();
  const pi: any = {
    on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
  };

  assert.equal(getGlobalJobManager().providers.get("bash"), undefined);
  bashJobsExtension(pi, () => "darwin");
  assert.equal(getGlobalJobManager().providers.get("bash"), undefined);
  assert.deepEqual([...handlers.keys()], []);
});

test("Herdr crash cleanup closes only the pane matching the persisted job label", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bash-recovery-herdr-"));
  const socketPath = join(dir, "herdr.sock");
  const methods: string[] = [];
  const server = createServer((socket) => {
    let request = "";
    socket.on("data", (chunk) => {
      request += chunk.toString("utf8");
      if (!request.includes("\n")) return;
      const parsed = JSON.parse(request.slice(0, request.indexOf("\n")));
      methods.push(parsed.method);
      const result = parsed.method === "pane.list"
        ? { type: "pane_list", panes: [{ pane_id: "pane-owned", workspace_id: "workspace-1", tab_id: "tab-1", label: "__pi_job__recover-me" }] }
        : { type: "ok" };
      socket.end(`${JSON.stringify({ id: parsed.id, result })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  const provider = new RoutedBashJobProvider();
  const job: any = {
    id: "recover-me",
    type: "bash",
    providerResource: {
      kind: "herdr_pane",
      socketPath,
      workspaceId: "workspace-1",
      paneId: "pane-owned",
      paneLabel: "__pi_job__recover-me",
    },
  };
  try {
    assert.deepEqual(await provider.recover({ ...job, providerResource: { ...job.providerResource, paneLabel: "not-owned" } }), {
      reclaimed: false,
      detail: "ownership label mismatch",
    });
    assert.deepEqual(methods, []);
    assert.deepEqual(await provider.recover(job), { reclaimed: true });
    assert.deepEqual(methods, ["pane.list", "pane.close"]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("local bash explicitly runs bash -c and captures combined output", async () => {
  const jobs = manager();
  const result = await jobs.start(
    { type: "bash", cmd: "printf 'stdout\\n'; printf 'stderr\\n' >&2; printf '%s\\n' \"$BASH_VERSION\"" },
    context("success"),
  );
  try {
    assert.equal(result.status, "completed");
    assert.equal(result.exitCode, 0);
    assert.match(result.output ?? "", /stdout/);
    assert.match(result.output ?? "", /stderr/);
    assert.match(result.output ?? "", /\d+\.\d+/);
  } finally {
    await cleanup(result.artifactDir);
  }
});

test("nonzero bash exits resolve as failed records", async () => {
  const jobs = manager();
  const result = await jobs.start({ type: "bash", cmd: "printf bad >&2; exit 23" }, context("nonzero"));
  try {
    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, 23);
    assert.match(result.output ?? "", /bad/);
  } finally {
    await cleanup(result.artifactDir);
  }
});

test("bash timeout and stop terminate the owned process group", async () => {
  const jobs = manager();
  const timed = await jobs.start({ type: "bash", cmd: "sleep 10", timeout: 0.05 }, context("timeout"));
  const running = await jobs.start({ type: "bash", cmd: "sleep 10", mode: "async" }, context("stop"));
  const stopped = await jobs.stop({ id: running.id });
  try {
    assert.equal(timed.status, "timed_out");
    assert.equal(stopped.status, "stopped");
  } finally {
    await cleanup(timed.artifactDir, running.artifactDir);
  }
});

test("nested JavaScript can launch bash only through parent RPC", async () => {
  const jobs = manager(true);
  const parent = await jobs.start(
    {
      type: "js",
      cmd: "const child = await job({ type: 'bash', cmd: `printf nested`, mode: 'sync' }); return { status: child.status, output: child.output, parentJobId: child.parentJobId }",
    },
    context("nested"),
  );
  try {
    assert.equal(parent.status, "completed");
    assert.match(parent.output ?? "", /status: completed/);
    assert.match(parent.output ?? "", /nested/);
    const history = jobs.list({ include: "non-running" }, parent.sessionId).nonRunning ?? [];
    assert.equal(history.length, 2);
    assert.equal(history.find((job) => job.type === "bash")?.parentJobId, parent.id);
  } finally {
    const history = jobs.list({ include: "non-running" }, parent.sessionId).nonRunning ?? [];
    await cleanup(...history.map((job) => job.artifactDir));
  }
});
