export type JobType = "js" | "bash";
export type JobMode = "sync" | "async";
export type TerminalJobStatus = "completed" | "failed" | "timed_out" | "stopped";
export type JobStatus = "starting" | "running" | TerminalJobStatus;

export interface JobStartInput {
  type: JobType;
  cmd: string;
  mode?: JobMode;
  timeout?: number;
}

export interface JobListInput {
  type?: JobType;
  include?: "running" | "non-running" | "all";
  cursor?: string;
}

export interface JobStopInput {
  id: string;
}

export interface JobInvocationContext {
  cwd: string;
  sessionId: string;
  sessionPath?: string;
  sessionTimestamp?: string;
  parentJobId?: string;
  rootToolCallId?: string;
}

export interface JobSnapshot {
  id: string;
  type: JobType;
  mode: JobMode;
  status: JobStatus;
  cwd: string;
  sessionId: string;
  parentJobId?: string;
  rootJobId: string;
  artifactDir: string;
  outputPath: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  output?: string;
  outputTruncated?: boolean;
  totalOutputLines?: number;
  totalOutputBytes?: number;
  exitCode?: number | null;
  signal?: string | null;
  error?: NormalizedJobError;
  stopReason?: string;
}

export interface JobListResult {
  running: JobSnapshot[];
  nonRunningCount: number;
  nonRunning?: JobSnapshot[];
  nextCursor?: string;
}

export interface NormalizedJobError {
  phase: string;
  name: string;
  code: string;
  message: string;
  stack?: string;
  cause?: unknown;
  exitCode?: number | null;
  signal?: string | null;
}

export interface ProviderTerminalResult {
  status: TerminalJobStatus;
  outputPath: string;
  outputText?: string;
  outputPersisted?: boolean;
  exitCode?: number | null;
  signal?: string | null;
  error?: NormalizedJobError;
  stopReason?: string;
}

export interface ProviderJobHandle {
  completion: Promise<ProviderTerminalResult>;
  stop(reason: string): Promise<void>;
}

export interface HostProcessIdentity {
  pid: number;
  startTimeTicks: string;
}

export interface LocalProcessResource {
  kind: "local_process";
  owner: "js" | "bash";
  pid: number;
  processGroupId: number;
  startTimeTicks: string;
}

export interface HerdrPaneResource {
  kind: "herdr_pane";
  socketPath: string;
  workspaceId: string;
  paneId: string;
  paneLabel: string;
}

export type ProviderResource = LocalProcessResource | HerdrPaneResource;

export interface PersistedJob extends JobSnapshot {
  hostProcess?: HostProcessIdentity;
  providerResource?: ProviderResource;
  deliveryState?: "none" | "pending" | "delivered";
}

export interface ProviderRecovery {
  reclaimed: boolean;
  detail?: string;
}

export interface ProviderStartContext {
  record: MutableJobRecord;
  invoke(method: "job" | "job_list" | "job_stop", args: unknown): Promise<unknown>;
  setResource(resource: ProviderResource): Promise<void>;
}

export interface JobProvider {
  readonly type: JobType;
  start(input: Required<Pick<JobStartInput, "type" | "cmd" | "mode">> & Pick<JobStartInput, "timeout">, context: ProviderStartContext): Promise<ProviderJobHandle>;
  recover?(job: PersistedJob): Promise<ProviderRecovery>;
}

export interface MutableJobRecord extends JobSnapshot {
  cmd: string;
  sessionPath?: string;
  rootToolCallId?: string;
  handle?: ProviderJobHandle;
  completion?: Promise<JobSnapshot>;
  hostProcess: HostProcessIdentity;
  providerResource?: ProviderResource;
  deliveryState: "none" | "pending" | "delivered";
}

export interface CompletionDelivery {
  job: JobSnapshot;
  content: string;
}

export interface CrashRecoveryOptions {
  artifactRoot?: string;
  now?: () => Date;
  isHostAlive?: (identity: HostProcessIdentity) => boolean | Promise<boolean>;
}

export interface CrashRecoveryResult {
  inspected: number;
  recovered: number;
  skippedLive: number;
  errors: Array<{ artifactDir: string; message: string }>;
}
