import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  captureOwnedProcess,
  JobManager,
  JavaScriptJobProvider,
  reclaimOwnedProcessGroup,
  truncateMiddle,
  type JobProvider,
  type PersistedJob,
} from "../src/index.ts";

function context(label: string) {
  return {
    cwd: process.cwd(),
    sessionId: `test-${label}-${crypto.randomUUID()}`,
    sessionTimestamp: new Date().toISOString(),
  };
}

async function cleanup(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

function manager(): JobManager {
  const value = new JobManager();
  value.providers.register(new JavaScriptJobProvider());
  return value;
}

test("local crash cleanup requires the exact detached process identity", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  assert.ok(child.pid);

  try {
    const resource = await captureOwnedProcess(child.pid, "js");
    assert.equal(await reclaimOwnedProcessGroup({ ...resource, startTimeTicks: `${resource.startTimeTicks}-wrong` }), false);
    assert.doesNotThrow(() => process.kill(child.pid!, 0));

    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    assert.equal(await reclaimOwnedProcessGroup(resource), true);
    await exited;
    assert.throws(() => process.kill(child.pid!, 0), (error: any) => error?.code === "ESRCH");
  } finally {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch (error: any) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
});

test("startup recovery reclaims stale artifacts, finalizes them without delivery, and skips a live host", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-jobs-recovery-"));
  const recoveredIds: string[] = [];
  const provider: JobProvider = {
    type: "js",
    async start() { throw new Error("not used"); },
    async recover(job: PersistedJob) {
      recoveredIds.push(job.id);
      return { reclaimed: true };
    },
  };
  const jobs = new JobManager();
  jobs.providers.register(provider);
  const deliveries: string[] = [];
  jobs.setDeliveryHandler((delivery) => { deliveries.push(delivery.job.id); });

  const writeManifest = async (id: string, status: "starting" | "running" | "completed", hostPid: number) => {
    const artifactDir = join(root, "cwd", "session", id);
    await mkdir(artifactDir, { recursive: true });
    const manifest = {
      id,
      type: "js",
      mode: "async",
      status,
      cwd: "/tmp",
      sessionId: "old-session",
      rootJobId: id,
      artifactDir,
      outputPath: join(artifactDir, "output.yaml"),
      startedAt: "2026-01-01T00:00:00.000Z",
      hostProcess: { pid: hostPid, startTimeTicks: `ticks-${hostPid}` },
      providerResource: { kind: "local_process", owner: "js", pid: 99, processGroupId: 99, startTimeTicks: "owned" },
      deliveryState: "pending",
    };
    await writeFile(join(artifactDir, "manifest.json"), `${JSON.stringify(manifest)}\n`);
    return artifactDir;
  };

  const startingDir = await writeManifest("stale-starting", "starting", 10);
  const runningDir = await writeManifest("stale-running", "running", 11);
  const liveDir = await writeManifest("live-reload", "running", 12);
  const terminalDir = await writeManifest("already-done", "completed", 13);
  try {
    const result = await jobs.recoverStaleArtifacts({
      artifactRoot: root,
      now: () => new Date("2026-01-02T00:00:00.000Z"),
      isHostAlive: (host) => host.pid === 12,
    });
    assert.deepEqual(result, { inspected: 3, recovered: 2, skippedLive: 1, errors: [] });
    assert.deepEqual(recoveredIds, ["stale-running", "stale-starting"]);
    assert.deepEqual(deliveries, []);

    for (const artifactDir of [startingDir, runningDir]) {
      const manifest = JSON.parse(await readFile(join(artifactDir, "manifest.json"), "utf8"));
      const persistedResult = JSON.parse(await readFile(join(artifactDir, "result.json"), "utf8"));
      assert.equal(manifest.status, "failed");
      assert.equal(manifest.stopReason, "host_crashed");
      assert.equal(manifest.error.code, "ERR_JOB_HOST_CRASHED");
      assert.equal(manifest.deliveryState, "none");
      assert.deepEqual(persistedResult, manifest);
      assert.equal((await readdir(artifactDir)).some((name) => name.includes(".tmp-")), false);
    }
    assert.equal(JSON.parse(await readFile(join(liveDir, "manifest.json"), "utf8")).status, "running");
    assert.equal(JSON.parse(await readFile(join(terminalDir, "manifest.json"), "utf8")).status, "completed");

    const repeated = await jobs.recoverStaleArtifacts({
      artifactRoot: root,
      isHostAlive: (host) => host.pid === 12,
    });
    assert.deepEqual(repeated, { inspected: 1, recovered: 0, skippedLive: 1, errors: [] });
    assert.deepEqual(recoveredIds, ["stale-running", "stale-starting"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("startup recovery finalizes host_crashed even when owned-resource cleanup fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-jobs-recovery-error-"));
  const artifactDir = join(root, "job");
  await mkdir(artifactDir, { recursive: true });
  await writeFile(join(artifactDir, "manifest.json"), `${JSON.stringify({
    id: "cleanup-failed",
    type: "bash",
    mode: "async",
    status: "running",
    cwd: "/tmp",
    sessionId: "old-session",
    rootJobId: "cleanup-failed",
    artifactDir,
    outputPath: join(artifactDir, "output.log"),
    startedAt: "2026-01-01T00:00:00.000Z",
    hostProcess: { pid: 10, startTimeTicks: "dead" },
    providerResource: { kind: "local_process", owner: "bash", pid: 99, processGroupId: 99, startTimeTicks: "owned" },
  })}\n`);
  const jobs = new JobManager();
  jobs.providers.register({
    type: "bash",
    async start() { throw new Error("not used"); },
    async recover() { throw Object.assign(new Error("cleanup transport failed"), { code: "ERR_TEST_CLEANUP" }); },
  });

  try {
    const recovery = await jobs.recoverStaleArtifacts({ artifactRoot: root, isHostAlive: () => false });
    assert.equal(recovery.recovered, 1);
    assert.equal(recovery.errors.length, 1);
    const manifest = JSON.parse(await readFile(join(artifactDir, "manifest.json"), "utf8"));
    assert.equal(manifest.status, "failed");
    assert.equal(manifest.stopReason, "host_crashed");
    assert.equal(manifest.error.code, "ERR_JOB_HOST_CRASHED");
    assert.equal(manifest.error.cause.code, "ERR_TEST_CLEANUP");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("crash recovery does not classify an in-memory job surviving reload as stale", async () => {
  let finish!: (value: any) => void;
  const completion = new Promise<any>((resolve) => { finish = resolve; });
  const recovered: string[] = [];
  const provider: JobProvider = {
    type: "js",
    async start(_input, providerContext) {
      await providerContext.setResource({ kind: "local_process", owner: "js", pid: 1, processGroupId: 1, startTimeTicks: "fake" });
      return {
        completion,
        async stop(reason) {
          finish({ status: "stopped", outputPath: providerContext.record.outputPath, stopReason: reason, outputText: "stopped" });
        },
      };
    },
    async recover(job) {
      recovered.push(job.id);
      return { reclaimed: true };
    },
  };
  const jobs = new JobManager();
  jobs.providers.register(provider);
  const running = await jobs.start({ type: "js", cmd: "pending", mode: "async" }, context("reload-recovery"));
  try {
    const result = await jobs.recoverStaleArtifacts({
      artifactRoot: running.artifactDir,
      isHostAlive: () => false,
    });
    assert.equal(result.skippedLive, 1);
    assert.equal(result.recovered, 0);
    assert.deepEqual(recovered, []);
    assert.equal(JSON.parse(await readFile(join(running.artifactDir, "manifest.json"), "utf8")).status, "running");
  } finally {
    await jobs.stop({ id: running.id });
    await cleanup(running.artifactDir);
  }
});

test("middle truncation preserves the beginning and end", () => {
  const input = Array.from({ length: 3_000 }, (_, index) => `line-${index}`).join("\n");
  const result = truncateMiddle(input);
  assert.equal(result.truncated, true);
  assert.match(result.text, /^line-0/);
  assert.match(result.text, /\[truncated\]/);
  assert.match(result.text, /line-2999$/);
  assert.ok(Buffer.byteLength(result.text) <= 50 * 1024);
  assert.ok(result.text.split("\n").length <= 2_000);
});

test("JavaScript jobs persist SuperJSON YAML and support circular values", async () => {
  const jobs = manager();
  const result = await jobs.start(
    { type: "js", cmd: "const value = { answer: 42 }; value.self = value; return value", mode: "sync" },
    context("circular"),
  );
  try {
    assert.equal(result.status, "completed");
    assert.match(result.output ?? "", /answer: 42/);
    assert.match(result.output ?? "", /referentialEqualities/);
  } finally {
    await cleanup(result.artifactDir);
  }
});

test("console access fails with guidance", async () => {
  const jobs = manager();
  const result = await jobs.start({ type: "js", cmd: "console.log('nope'); return 1" }, context("console"));
  try {
    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "ERR_JOB_CONSOLE_UNAVAILABLE");
    assert.match(result.error?.message ?? "", /Return data explicitly/);
  } finally {
    await cleanup(result.artifactDir);
  }
});

test("filesystem and network are available while subprocesses remain denied", async () => {
  const server = createServer((_request, response) => response.end("network-ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const jobs = manager();
  const fsResult = await jobs.start(
    {
      type: "js",
      cmd: `const fs = await import('node:fs/promises'); const body = await (await fetch('http://127.0.0.1:${address.port}')).text(); return { body, packageSize: (await fs.stat('package.json')).size }`,
    },
    context("io"),
  );
  const denied = await jobs.start(
    { type: "js", cmd: "const cp = await import('node:child_process'); cp.spawnSync('true'); return 'unexpected'" },
    context("denied"),
  );
  server.close();
  try {
    assert.equal(fsResult.status, "completed");
    assert.match(fsResult.output ?? "", /network-ok/);
    assert.equal(denied.status, "failed");
    assert.match(`${denied.error?.code} ${denied.error?.message}`, /ACCESS_DENIED|permission/i);
  } finally {
    await cleanup(fsResult.artifactDir);
    await cleanup(denied.artifactDir);
  }
});

test("nested jobs use the shared RPC surface and do not deliver notifications", async () => {
  const jobs = manager();
  const deliveries: string[] = [];
  jobs.setDeliveryHandler((delivery) => { deliveries.push(delivery.job.id); });
  const parent = await jobs.start(
    {
      type: "js",
      cmd: `const child = await job({ type: 'js', mode: 'sync', cmd: 'return { nested: true }' }); return { status: child.status, output: child.output, parent: child.parentJobId }`,
    },
    context("nested"),
  );
  try {
    assert.equal(parent.status, "completed");
    assert.match(parent.output ?? "", /nested: true/);
    assert.deepEqual(deliveries, []);
    assert.equal(jobs.list({ include: "non-running" }, parent.sessionId).nonRunningCount, 2);
  } finally {
    const history = jobs.list({ include: "non-running" }, parent.sessionId).nonRunning ?? [];
    await Promise.all(history.map((job) => cleanup(job.artifactDir)));
  }
});

test("session shutdown stops an async descendant after its parent completes exactly once", async () => {
  let finishChild!: (value: any) => void;
  let childStopCalls = 0;
  const provider: JobProvider = {
    type: "js",
    async start(input, providerContext) {
      if (input.cmd === "parent") {
        await providerContext.invoke("job", { type: "js", cmd: "child", mode: "async" });
        return {
          completion: Promise.resolve({
            status: "completed",
            outputPath: providerContext.record.outputPath,
            outputText: "parent completed",
          }),
          async stop() {},
        };
      }
      return {
        completion: new Promise((resolve) => { finishChild = resolve; }),
        async stop(reason) {
          childStopCalls += 1;
          finishChild({
            status: "stopped",
            outputPath: providerContext.record.outputPath,
            stopReason: reason,
            outputText: "child stopped",
          });
        },
      };
    },
  };
  const jobs = new JobManager();
  jobs.providers.register(provider);
  const invocation = context("session-descendant");
  const parent = await jobs.start({ type: "js", cmd: "parent" }, invocation);
  const child = jobs.list({}, invocation.sessionId).running.at(0);
  assert.equal(parent.status, "completed");
  assert.ok(child);
  assert.equal(child.parentJobId, parent.id);

  try {
    await Promise.all([
      jobs.stopSession(invocation.sessionId, "session_replaced"),
      jobs.stopSession(invocation.sessionId, "session_replaced"),
    ]);
    assert.equal(jobs.get(child.id)?.status, "stopped");
    assert.equal(jobs.get(child.id)?.stopReason, "session_replaced");
    assert.equal(childStopCalls, 1);
    assert.deepEqual(jobs.list({}, invocation.sessionId).running, []);
  } finally {
    await Promise.all([cleanup(parent.artifactDir), cleanup(child.artifactDir)]);
  }
});

test("async jobs can be stopped and root completion is delivered once", async () => {
  const jobs = manager();
  const deliveries: string[] = [];
  jobs.setDeliveryHandler((delivery) => { deliveries.push(delivery.job.id); });
  const running = await jobs.start(
    { type: "js", mode: "async", cmd: "await new Promise(() => {}); return 1" },
    context("stop"),
  );
  const stopped = await jobs.stop({ id: running.id });
  try {
    assert.equal(stopped.status, "stopped");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(deliveries, [running.id]);
  } finally {
    await cleanup(running.artifactDir);
  }
});
