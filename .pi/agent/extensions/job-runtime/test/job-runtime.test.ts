import assert from "node:assert/strict";
import { createServer } from "node:http";
import { rm } from "node:fs/promises";
import test from "node:test";

import { JobManager, JavaScriptJobProvider, truncateMiddle } from "../src/index.ts";

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
  jobs.setDeliveryHandler((delivery) => deliveries.push(delivery.job.id));
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

test("async jobs can be stopped and root completion is delivered once", async () => {
  const jobs = manager();
  const deliveries: string[] = [];
  jobs.setDeliveryHandler((delivery) => deliveries.push(delivery.job.id));
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
