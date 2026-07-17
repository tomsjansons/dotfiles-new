import { readFile } from "node:fs/promises";

import type { HostProcessIdentity, LocalProcessResource } from "./types.ts";

const RECOVERY_STOP_GRACE_MS = 5_000;
const RECOVERY_POLL_MS = 50;

interface ProcStat {
  processGroupId: number;
  startTimeTicks: string;
}

async function readProcStat(pid: number): Promise<ProcStat | undefined> {
  try {
    const value = await readFile(`/proc/${pid}/stat`, "utf8");
    const close = value.lastIndexOf(")");
    if (close < 0) return undefined;
    // Fields after comm begin at field 3 (state). pgrp is field 5 and
    // starttime is field 22; parsing after the final ')' handles spaces in comm.
    const fields = value.slice(close + 2).trim().split(/\s+/);
    const processGroupId = Number(fields[2]);
    const startTimeTicks = fields[19];
    if (!Number.isSafeInteger(processGroupId) || !startTimeTicks) return undefined;
    return { processGroupId, startTimeTicks };
  } catch (error: any) {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") return undefined;
    throw error;
  }
}

export async function currentHostIdentity(): Promise<HostProcessIdentity> {
  const stat = await readProcStat(process.pid);
  if (!stat) throw new Error(`Unable to identify host process ${process.pid}`);
  return { pid: process.pid, startTimeTicks: stat.startTimeTicks };
}

export async function isHostProcessAlive(identity: HostProcessIdentity): Promise<boolean> {
  if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0 || typeof identity.startTimeTicks !== "string") return false;
  return (await readProcStat(identity.pid))?.startTimeTicks === identity.startTimeTicks;
}

export async function captureOwnedProcess(
  pid: number,
  owner: LocalProcessResource["owner"],
): Promise<LocalProcessResource> {
  const stat = await readProcStat(pid);
  if (!stat || stat.processGroupId !== pid) {
    throw Object.assign(new Error(`Unable to verify detached ${owner} process group ${pid}`), {
      code: "ERR_JOB_PROCESS_OWNERSHIP",
    });
  }
  return { kind: "local_process", owner, pid, processGroupId: pid, startTimeTicks: stat.startTimeTicks };
}

function signalGroup(processGroupId: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-processGroupId, signal);
    return true;
  } catch (error: any) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

/** Reclaims only a process group whose leader still has the persisted Linux start time. */
export async function reclaimOwnedProcessGroup(resource: LocalProcessResource): Promise<boolean> {
  if (
    !Number.isSafeInteger(resource.pid) || resource.pid <= 0 ||
    resource.processGroupId !== resource.pid ||
    typeof resource.startTimeTicks !== "string"
  ) return false;
  const stat = await readProcStat(resource.pid);
  if (!stat || stat.processGroupId !== resource.processGroupId || stat.startTimeTicks !== resource.startTimeTicks) return false;

  if (!signalGroup(resource.processGroupId, "SIGTERM")) return true;
  const deadline = Date.now() + RECOVERY_STOP_GRACE_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, RECOVERY_POLL_MS));
    const leader = await readProcStat(resource.pid);
    if (leader && (leader.processGroupId !== resource.processGroupId || leader.startTimeTicks !== resource.startTimeTicks)) {
      return false;
    }
    if (!signalGroup(resource.processGroupId, 0)) return true;
  }
  const leader = await readProcStat(resource.pid);
  if (leader && (leader.processGroupId !== resource.processGroupId || leader.startTimeTicks !== resource.startTimeTicks)) {
    return false;
  }
  signalGroup(resource.processGroupId, "SIGKILL");
  return true;
}
