export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface HerdrContext {
  socketPath: string;
  paneId: string;
  tabId: string;
  workspaceId: string;
  version: string;
  protocol: number;
}

export interface HerdrTab {
  tab_id: string;
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
}

export interface HerdrPane {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  focused: boolean;
  cwd?: string;
  foreground_cwd?: string;
  label?: string;
  revision: number;
}

export interface CreatedTab {
  tab: HerdrTab;
  rootPane: HerdrPane;
}

export interface HerdrClient {
  ping(options?: RequestOptions): Promise<{ version: string; protocol: number }>;
  getPane(paneId: string, options?: RequestOptions): Promise<HerdrPane>;
  listTabs(workspaceId: string, options?: RequestOptions): Promise<HerdrTab[]>;
  listPanes(workspaceId: string, options?: RequestOptions): Promise<HerdrPane[]>;
  createTab(input: { workspaceId: string; cwd: string; label: string; focus: boolean }, options?: RequestOptions): Promise<CreatedTab>;
  splitPane(input: { workspaceId: string; targetPaneId: string; direction: "right" | "down"; ratio: number; cwd: string; focus: boolean }, options?: RequestOptions): Promise<HerdrPane>;
  renamePane(paneId: string, label: string, options?: RequestOptions): Promise<void>;
  sendInput(paneId: string, text: string, options?: RequestOptions): Promise<void>;
  closePane(paneId: string, options?: RequestOptions): Promise<void>;
}

export interface HerdrCommandInput {
  id: string;
  cmd: string;
  cwd: string;
  artifactDir: string;
  outputPath: string;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
}

export interface HerdrCommandResult {
  status: "completed" | "failed" | "timed_out" | "stopped";
  outputText: string;
  exitCode?: number | null;
  signal?: string | null;
  stopReason?: string;
  error?: { code: string; message: string; stack?: string };
}

export interface HerdrCommandHandle {
  completion: Promise<HerdrCommandResult>;
  stop(reason: string): Promise<void>;
}

export interface HerdrJobHost {
  start(input: HerdrCommandInput): Promise<HerdrCommandHandle>;
}
