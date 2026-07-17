import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";

import { JavaScriptJobProvider, JobManager } from "@dotfiles/job-runtime";
import { LocalBashJobProvider } from "../src/index.ts";

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
