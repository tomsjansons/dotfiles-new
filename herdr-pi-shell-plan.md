# Herdr-backed Pi shell plan

Status: **implemented and verified with automated local-provider tests plus live Herdr-routed test execution.**

## Architectural reset

Herdr-backed bash is now **step two**, not the foundation. The design has two ordered product steps and three reusable modules.

### Tool-plane split

The model-facing tool surface is intentionally divided by role:

- **Pi work tools stay direct in the agent context.** `read`, `write`, `edit`, `vent`, and similar tools remain ordinary Pi tools with native renderers/hooks. JavaScript jobs do not receive those Pi tool wrappers, but they do have unrestricted raw Node filesystem and network APIs.
- **One job toolset spans both planes.** The normal Pi context and every JavaScript job receive the same `job`, `job_list`, and `job_stop` operations.
- **The standalone `bash` model tool is inactive by default, not unregistered.** Users may temporarily restore it with `/bash-tool on` and disable it again with `/bash-tool off`; normal model shell work uses `job({ type: "bash", ... })` once that provider is installed.

Step one does not bridge installed Pi tools. A provider registry admits explicit job types; raw filesystem/network access is ordinary child-process capability, not invocation of Pi's work-plane tools.

### Step one: JavaScript jobs

Build a provider-agnostic Pi job extension with three model-facing tools, mirrored as awaitable globals inside JavaScript jobs:

```ts
job({
  type: "js",
  cmd: "return 42",
  mode: "sync" | "async",
  timeout?: number,
});

job_list(options?);
job_stop({ id });
```

Sync JavaScript jobs return final output now. Async jobs return an ID/path immediately and inject exactly one terminal result into the originating Pi thread. Nested `job({ type: "js" })` calls are allowed and create another isolated child through parent-host RPC.

Program output is persisted by path. The outer agent may use Pi's direct `read`; JavaScript jobs may use `node:fs/promises`. There are no dedicated job read/wait operations.

### Step two: routed bash jobs

Build the reusable Herdr library and a bash job provider over the same three-operation interface. The provider checks each job's context: validated Herdr runs in a fresh `pi-shell` pane; otherwise it launches bash directly as a managed local process. The standalone Pi `bash` tool is already inactive by default through `pi-jobs`.

```ts
const child = await job({
  type: "bash",
  cmd: "pnpm dev",
  mode: "async",
});
return child; // includes id and outputPath
```

The agent can inspect `outputPath` with normal direct `read`; a parent JavaScript job can inspect it with `node:fs/promises`. Waiting uses ordinary Promise/timer composition followed by filesystem reads or `job_list()`.

A future, out-of-scope subagent provider will reuse the Herdr library and may add another `job.type`: create/use a configurable `pi-sub` tab, open a pane, launch Pi there with the subagent instructions, and expose its lifecycle through the same job manager. The current task must preserve that seam but not implement subagents.

## Confirmed platform facts

- Herdr provides a newline-delimited JSON protocol over `HERDR_SOCKET_PATH`; its own client opens a connection, writes one JSON request plus `\n`, and reads one JSON response line ([source](https://github.com/ogulcancelik/herdr/blob/299dd4163a96381ec2d8e5bde13d7ba6d6432373/src/api/client.rs#L32-L62), [wire framing](https://github.com/ogulcancelik/herdr/blob/299dd4163a96381ec2d8e5bde13d7ba6d6432373/src/api/client.rs#L207-L223)).
- `tab.create` returns both the tab and its root pane, so a newly created target tab can retain a dedicated anchor pane ([source](https://github.com/ogulcancelik/herdr/blob/299dd4163a96381ec2d8e5bde13d7ba6d6432373/src/api/schema/response.rs#L87-L96)).
- `pane.split` creates a real shell pane and accepts an explicit target pane, cwd, environment, focus flag, direction, and ratio ([schema](https://github.com/ogulcancelik/herdr/blob/299dd4163a96381ec2d8e5bde13d7ba6d6432373/src/api/schema/panes.rs#L8-L23), [implementation](https://github.com/ogulcancelik/herdr/blob/299dd4163a96381ec2d8e5bde13d7ba6d6432373/src/app/api/panes.rs#L33-L124)).
- `pane.run` is only an atomic text-plus-Enter injection; it does not return command output or an exit code ([source](https://github.com/ogulcancelik/herdr/blob/299dd4163a96381ec2d8e5bde13d7ba6d6432373/src/cli/pane.rs#L929-L942)).
- `pane.wait_for_output` polls terminal text for a marker and returns the matching read, but it is not process completion tracking ([source](https://github.com/ogulcancelik/herdr/blob/299dd4163a96381ec2d8e5bde13d7ba6d6432373/src/api/wait.rs#L20-L126)).
- Herdr emits `pane.exited`, but that public event does not carry the process exit code ([source](https://github.com/ogulcancelik/herdr/blob/299dd4163a96381ec2d8e5bde13d7ba6d6432373/src/api/schema/events.rs#L493-L501)).
- Pi's built-in bash backend supports streaming, abort, timeout, cwd, environment, and process-tree termination, but it selects the configured shell. The unified `type: "bash"` provider needs similar lifecycle behavior while explicitly spawning bash instead.
- Pi's built-in bash tool is foreground-only and has no managed job IDs or async lifecycle.
- This repo's `hashline-tools` extension overrides `bash`; `pi-jobs` removes the active `bash` name after every extension/session reload without disturbing other active tools, while `/bash-tool on|off` provides an explicit user-controlled escape hatch.
- Pi 0.80.3 does **not** publicly expose registered tool executors. `pi.getAllTools()` returns metadata only; the internal session has full definitions, but `ExtensionAPI` has no invoke method. The design therefore exposes only explicit job providers and never attempts a generic bridge to installed Pi tools.
- Existing provider-agnostic PTC extensions use the same broad architecture proposed here: an isolated subprocess, generated async wrappers, and host RPC. `pi-ptc-next` recreates built-in executors and can invoke only custom executors it captured itself, confirming the public Pi limitation.
- SuperJSON 2.2.5 supports circular references even though its README does not advertise them. Its walker tracks object identity, short-circuits previously seen values, and replaces an active cycle edge with `null` ([walker](https://github.com/flightcontrolhq/superjson/blob/aaa65e36e8e31da740265a56b27c965ca1c7b754/src/plainer.ts#L188-L235)); serialization emits referential-equality metadata ([serialize](https://github.com/flightcontrolhq/superjson/blob/aaa65e36e8e31da740265a56b27c965ca1c7b754/src/index.ts#L33-L58)); deserialization restores repeated and root/self references ([restore](https://github.com/flightcontrolhq/superjson/blob/aaa65e36e8e31da740265a56b27c965ca1c7b754/src/plainer.ts#L81-L114)). The repository includes an explicit cyclic parent/child test ([test](https://github.com/flightcontrolhq/superjson/blob/aaa65e36e8e31da740265a56b27c965ca1c7b754/src/index.test.ts#L330-L348)).

### Code-as-orchestration inspiration

Use `pi-dynamic-workflows` as the reference shape for the orchestration mechanism, not as a feature checklist. At commit `2f28a74799ca83cd2dc35afc068091ba52167e04`, its useful pattern is:

- parse/validate a raw JavaScript program, inject a deliberately small set of async host functions as globals, wrap the body in an async function, and await its returned value ([runtime context and wrapper](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/2f28a74799ca83cd2dc35afc068091ba52167e04/src/workflow.ts#L885-L937));
- keep intermediate host-call results in JavaScript variables and place only the explicitly returned final value in model context;
- route both foreground and background execution through one manager, with the foreground path awaiting the same managed run that background starts detached ([manager paths](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/2f28a74799ca83cd2dc35afc068091ba52167e04/src/workflow-manager.ts#L175-L269));
- represent runs explicitly with ID, status, abort controller, timestamps, script, arguments, output path, result metadata, and error rather than treating background execution as a loose Promise;
- deliver detached completion with `triggerTurn: true` plus `deliverAs: "followUp"` ([delivery](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/2f28a74799ca83cd2dc35afc068091ba52167e04/src/task-panel.ts#L139-L188));
- keep a single manager instance shared by the execution tool and lifecycle controls so asynchronous runs remain discoverable.

Do **not** copy its agent-specific DSL, phases, hooks, model routing, worktrees, checkpoints, quality helpers, or saved workflows. Our globals are generated orchestration capabilities plus standard JavaScript runtime facilities. Add convenience helpers only after repeated agent behavior proves they earn their interface cost.

Also do not copy `node:vm` as a security claim. The reference explicitly notes that injected host functions make `vm` only a best-effort guard, not a security sandbox ([warning](https://github.com/QuintinShaw/pi-dynamic-workflows/blob/2f28a74799ca83cd2dc35afc068091ba52167e04/src/workflow.ts#L227-L242)). Preserve its ergonomic orchestration shape while choosing isolation separately.

## Proposed package layout

```text
.pi/agent/extensions/
├── job-runtime/                     # unified manager + JS child runtime/RPC
│   ├── src/
│   │   ├── manager.ts
│   │   ├── providers.ts
│   │   ├── js-provider.ts
│   │   ├── rpc.ts
│   │   ├── artifacts.ts
│   │   └── types.ts
│   └── test/
├── pi-jobs/                         # three Pi tools + matching JS wrappers
│   ├── src/
│   │   ├── index.ts
│   │   ├── completion-messages.ts
│   │   └── rendering.ts
│   └── test/
├── herdr/                           # reusable Herdr library; no Pi imports
│   ├── src/
│   │   ├── client.ts
│   │   ├── discovery.ts
│   │   ├── panes.ts
│   │   ├── jobs.ts
│   │   ├── runner.ts
│   │   └── index.ts
│   └── test/
└── bash-jobs/                        # routed local/Herdr `bash` provider
    ├── src/
    │   ├── index.ts
    │   ├── provider.ts
    │   ├── local-backend.ts
    │   ├── herdr-backend.ts
    │   └── runner.ts
    └── test/
```

All names are provisional. Add packages to the existing pnpm workspace without disturbing unrelated local changes.

These are local dotfiles workspace packages only. Mark them private, add no npm publication/release setup, and make no public compatibility commitment.

## Module design

### 1. Unified job module

The external interface is one deep `JobManager`, a small provider-registration seam, and the same three operations in both the normal Pi context and every JavaScript job.

#### Shared tool interface

```ts
job({
  type: "js" | "bash",
  cmd: string,
  mode?: "sync" | "async",  // default sync
  timeout?: number,           // seconds; no default
});

job_list({
  type?: "js" | "bash",
  include?: "running" | "non-running" | "all",
  cursor?: string,
});

job_stop({ id: string });
```

The direct Pi tools use this object schema. The JavaScript runtime receives awaitable `job`, `job_list`, and `job_stop` globals with the same object arguments and normalized results.

`job` has no `cwd` option. Root jobs capture the current Pi invocation cwd; nested jobs inherit their parent's cwd. Directory changes remain explicit in bash `cmd` (for example `cd ... && ...`) rather than becoming hidden job-manager state.

A sync job persists complete output and returns a bounded head/tail projection plus its path. An async job returns ID/type/status/artifact paths immediately and injects exactly one terminal notification later. Omission of `timeout` means no deadline.

All ordinary terminal outcomes resolve with a discriminated record: `completed`, `failed`, `timed_out`, or `stopped`. This includes thrown JavaScript and nonzero bash. Only invalid requests, unavailable/corrupt providers, launch failures, and transport/integrity failures reject/throw.

Step one registers only the `js` provider. Step two always registers `bash`; its backend router chooses validated Herdr or managed local bash before launch.

Step one has no configuration file. The artifact root, transcript limits, 5-second JavaScript stop grace, lack of a default timeout, and lack of a concurrency limit are fixed v1 behavior and centralized as named constants.

#### Manager and lifecycle controls

Both sync and async paths go through one process-global `JobManager`, keyed with `Symbol.for(...)` so `/reload` can attach a replacement Pi adapter without losing live children or completion events. The manager owns IDs, provider type, status transitions, parent job ID, ancestry, timestamps, session identity, output/artifact paths, terminal metadata, and exactly-once delivery state.

`job_list()` defaults to every running job plus only the current session's total non-running count. Explicit `non-running` returns the newest 50 matching current-session terminal records and an opaque `nextCursor`; later pages pass that cursor. `all` returns all running jobs plus the same paginated terminal page. Type filtering applies before counts/pagination. Historical sessions remain filesystem artifacts.

`job_stop({ id })` dispatches to the owning provider, waits for terminal artifact finalization, and returns metadata/path. Repeated stops are idempotent. The JavaScript provider aborts nested host calls, sends `SIGTERM` to its process group, and escalates to `SIGKILL` after 5 seconds. Bash uses its Herdr pane-specific stop implementation.

Nested callers must inspect `status` explicitly. A failed child record does not throw into or automatically fail its parent; parent failure/cascade occurs only when the parent program itself throws or the parent is timed out/stopped.

There are deliberately no job read or wait operations. Output paths are consumed with normal Pi `read` in the outer plane or raw Node filesystem APIs inside JavaScript. Waiting is ordinary composition:

```js
const fs = await import("node:fs/promises");
await new Promise((resolve) => setTimeout(resolve, 5000));
const jobs = await job_list({ include: "running" });
const output = await fs.readFile(child.outputPath, "utf8");
return { jobs, output };
```

#### Compact TUI renderer

Use self-shell custom renderers so `job`, `job_list`, and `job_stop` appear as compact, unboxed status rows matching the direct file tools. A settled call occupies one row rather than separate call/result rows and shows type/mode, job ID, status, and elapsed/final duration. While a synchronous job runs, issue throttled partial updates only when status or displayed duration changes.

Submitted JavaScript/bash source is hidden by default. `/job-details on|off` toggles full, width-wrapped command lines beneath subsequent `job` rows for the current extension session; startup/reload defaults it to off. Output, errors, and artifact paths remain model-result content rather than collapsed TUI detail.

This is presentation-only: model-facing results and async completion still contain bounded output/diagnostics and `output.yaml` or `output.log` paths.

#### Job-provider seam

```ts
type JobType = "js" | "bash";

interface JobProvider {
  readonly type: JobType;
  start(input: JobStartInput, context: JobContext): Promise<ProviderJob>;
  stop(job: JobRecord, context: JobContext): Promise<ProviderTerminalResult>;
  recover?(job: PersistedJob, context: JobContext): Promise<ProviderRecovery>;
}

interface JobProviderRegistry {
  register(provider: JobProvider): Disposable;
  get(type: JobType): JobProvider | undefined;
}
```

The manager validates one shared schema and delegates type-specific launch/stop/recovery. Tests use in-memory providers. The production JavaScript provider creates a restricted child; the Herdr extension later contributes the bash provider.

Every JavaScript child receives only `job`, `job_list`, and `job_stop` over typed RPC. Nested `job({ type: "js" })` and mixed nested bash jobs are allowed with no imposed depth or concurrency limit. Each child records `parentJobId` and ancestry so diagnostics and future policy can reason about the tree.

There is no generic bridge to Pi tools. `read`, `write`, `edit`, `vent`, and their hooks/hashline semantics remain absent inside JavaScript. Planning code may instead use unrestricted Node filesystem/network APIs directly.

#### Runtime isolation

Run each `type: "js"` job in its own Node child process with Node's permission model enabled. Grant unrestricted filesystem reads/writes and unrestricted network access (`--allow-fs-read=*`, `--allow-fs-write=*`, and all-network permission). Do not grant child-process, worker, native-addon, FFI, WASI, or inspector permissions.

Inside the child, create a fresh `node:vm` context containing the three RPC wrappers, standard language globals, Promise/timers, and Node web globals such as `fetch`, `Headers`, `Request`, and `Response`. Configure `importModuleDynamically` so code can use unrestricted dynamic ESM imports resolved from its inherited cwd, including:

```js
const fs = await import("node:fs/promises");
const response = await fetch("https://example.com/data.json");
```

Static imports are unavailable because `cmd` is an async function body; tool instructions use dynamic `import()`. `process` and `require` are not injected as convenience globals, though unrestricted module imports may obtain Node modules. Importing dangerous modules is not itself blocked, but operations such as `child_process.spawn()`, workers, or native-addon loading must fail under the outer Node permission boundary; shell work goes through `job({ type: "bash" })`.

Do not provide a working console or output helper. Bind `console` to a hostile proxy whose property access or reflective use throws `ConsoleUnavailableError` with code `ERR_JOB_CONSOLE_UNAVAILABLE`, explaining that programs output data by explicitly returning it.

Spawn with `stdio: ["ignore", "ignore", "ignore", "ipc"]`. Child stdin/stdout/stderr are neither inherited nor piped into Pi. Results, errors, lifecycle events, and nested job RPC use typed IPC only.

The parent `JobManager` validates nested calls, delegates providers, records events, persists output, propagates cancellation, and kills the JavaScript child on timeout, stop, IPC failure, or session teardown. A CPU-bound infinite loop can freeze only its child.

`node:vm` is an ergonomics/namespace layer, not a data-security boundary. If code escapes the VM, it remains in a separate process but intentionally has full user-level filesystem/network access. Tests must prove those capabilities work while subprocesses, workers, addons, FFI/WASI, and inspector remain denied.

A nested synchronous job returns only normalized metadata, the bounded head/tail textual projection, and `outputPath`; it never injects the complete typed child value into its JavaScript caller. The parent may return that projection/path if it wants to surface the child. Validate JS syntax before spawning and wrap the body as an async program so top-level `await` and `return` work.

#### Output capture and transcript truncation

A JavaScript job emits output only through its final return value. Use pinned SuperJSON 2.2.5, bundled into the fixed child bootstrap, to serialize supported values—including circular/repeated references, `undefined`, `BigInt`, `Date`, `RegExp`, `Set`, `Map`, `Error`, URL, and supported typed arrays. Encode the complete `{ json, meta? }` envelope as deterministic YAML in `output.yaml` using a pinned YAML emitter. Configure multiline strings as block scalars and wrap long scalar output so the normal line-oriented `read` tool can paginate it; parsing the YAML and passing the envelope to `SuperJSON.deserialize()` must reconstruct the value. Reject unsupported functions, unregistered symbols/classes, or serialization failures with `ERR_JOB_RESULT_NOT_SERIALIZABLE`; never silently omit them. A normalized failure is likewise persisted as a full SuperJSON envelope while `result.json` records status.

Never place unbounded output in model context. Match Pi's existing tool-output limits: at most 2,000 lines and 50 KiB of UTF-8 text, with either limit independently triggering middle truncation. Reserve space for a literal `[truncated]` marker, then split the remaining line and byte budgets approximately evenly between a prefix and suffix. Preserve UTF-8 boundaries; an individual oversized line may be cut so both the beginning and end remain visible. Report omitted line/byte counts as result metadata outside the projection.

Always show the absolute `output.yaml` path. The file contains the complete YAML-encoded SuperJSON envelope, never the transcript-truncated projection. The agent uses its normal direct `read` tool when it needs the full output. Synchronous partial rendering shows status/duration only because there is no console stream; the bounded output appears when execution completes.

The same bounded contract applies when a synchronous JS job is called from another JS job: return the YAML head/tail projection with metadata and `output.yaml`, not the full SuperJSON-deserialized value.

Bash output uses the same 2,000-line/50-KiB middle projection for sync results and root completion messages. Decode the preview as UTF-8 with replacement for invalid sequences; `output.log` retains the complete original combined bytes.

Async JS startup returns job ID, artifact directory, and expected `output.yaml` path. Lifecycle events do not wake for nested jobs; async roots receive bounded completion delivery.

#### Failure diagnostics

Every failure writes a normalized diagnostic value through the same SuperJSON-to-YAML output path. Include the phase (`validation`, `bootstrap`, `execution`, `serialization`, `timeout`, `stop`, or `host_lifecycle`), error name, stable code, message, complete stack, recursively serializable cause, and child exit code/signal when applicable. Preserve non-`Error` thrown values explicitly rather than coercing them to an unhelpful string.

Compile the wrapper with the persisted absolute `source.js` filename and compensate for wrapper lines so syntax and runtime stack locations point to agent-authored line numbers. Keep `wrapped.js` for diagnosing transformation offsets. Fatal child failures that cannot report a JavaScript stack still record process exit/signal and the last acknowledged lifecycle phase.

The permanent `output.yaml` and `result.json` contain full diagnostics. The Pi tool result and async completion use the same 2,000-line/50-KiB middle-truncation projection as successful output.

JavaScript throws are normalized into `status: "failed"` records rather than rethrown through `job()`. Their full diagnostics remain in artifacts and bounded projection.

#### Job artifacts and debugging

Create the artifact directory and persist the exact input before starting any provider. Every job directory contains:

- `manifest.json`: job/session/parent IDs, type, mode, cwd, timestamps, runtime/provider versions, status, and limits;
- `events.jsonl`: append-only state, nested-call, provider diagnostic, cancellation, and recovery events;
- `result.json`: atomic terminal status, type-specific exit/error metadata, output statistics, and output reference.

JavaScript jobs additionally contain:

- `source.js`: exact model-supplied `cmd`;
- `wrapped.js`: generated async wrapper used for stack mapping;
- `output.yaml`: complete YAML encoding of the SuperJSON return/failure envelope.

Bash jobs additionally contain:

- `request.json`: runner request including the exact opaque command and launch metadata;
- `output.log`: complete append-only combined stdout/stderr bytes.

Results expose job/type/artifact/output paths. Parent/providers are authoritative writers by convention, not filesystem isolation: JS has unrestricted access and can inspect or modify artifacts. The manager keeps authoritative state in memory while alive and atomically rewrites/finalizes common records after child termination.

Store every provider's artifacts under Pi's global directory:

```text
~/.pi/pi-execute/
└── <cwd-slug>/
    └── <session-timestamp>-<session-id>/
        └── <job-timestamp>-<job-id>/
            ├── manifest.json
            ├── events.jsonl
            ├── result.json
            └── <type-specific files>
```

Current Pi session headers keep ID, timestamp, and cwd separately, so include a path-safe cwd slug and prefix a normalized timestamp. If a future ID already contains a readable normalized timestamp, do not duplicate it. Use Pi's existing cwd-slug convention where practical.

All job history and artifacts persist indefinitely until manual deletion. Temporary transport files may be atomically replaced during execution, but the finalized artifacts above are never pruned automatically.


### 2. Reusable Herdr library

The library should be a deep module. Callers should not need to know socket framing, request IDs, Herdr response envelopes, pane ID churn, shell startup races, output markers, sidecar files, or cleanup ordering.

#### Public interface

Proposed interface, subject to refinement during implementation:

```ts
export type HerdrContext = {
  socketPath: string;
  paneId: string;
  tabId: string;
  workspaceId: string;
  version: string;
  protocol: number;
};

export async function discoverHerdr(
  env?: NodeJS.ProcessEnv,
  options?: { signal?: AbortSignal },
): Promise<HerdrContext | undefined>;

export interface HerdrClient {
  listTabs(workspaceId: string, options?: RequestOptions): Promise<HerdrTab[]>;
  listPanes(workspaceId: string, options?: RequestOptions): Promise<HerdrPane[]>;
  createTab(input: CreateTabInput, options?: RequestOptions): Promise<CreatedTab>;
  splitPane(input: SplitPaneInput, options?: RequestOptions): Promise<HerdrPane>;
  sendInput(input: SendInputInput, options?: RequestOptions): Promise<void>;
  readPane(input: ReadPaneInput, options?: RequestOptions): Promise<PaneRead>;
  closePane(paneId: string, options?: RequestOptions): Promise<void>;
}

export interface HerdrJobHost {
  run(input: ForegroundJobInput, hooks?: JobHooks): Promise<JobResult>;
  start(input: BackgroundJobInput, hooks?: JobHooks): Promise<JobHandle>;
  inspect(jobId: string): Promise<JobSnapshot>;
  wait(jobId: string, options?: WaitOptions): Promise<JobResult>;
  stop(jobId: string, options?: StopOptions): Promise<JobResult>;
  list(): Promise<JobSnapshot[]>;
}

export function createJobHost(options: {
  client: HerdrClient;
  workspaceId: string;
  tabLabel: string;
  missingTab: "create" | "error" | "unavailable";
  split?: { direction: "right" | "down"; ratio?: number };
}): HerdrJobHost;
```

Keep a generic raw `request()` private unless a real second caller proves it is needed. The low-level client methods are the reusable Herdr primitives; `HerdrJobHost` is the high-leverage interface other shell-oriented extensions should normally use.

#### Discovery and capability check

1. Require `HERDR_ENV=1`, `HERDR_SOCKET_PATH`, and `HERDR_PANE_ID`.
2. Connect to the socket and issue `ping`; environment variables alone are not sufficient.
3. Resolve the calling pane using the explicit pane ID, then trust the server-returned `workspace_id` and `tab_id` over separately inherited IDs.
4. Validate the minimum Herdr protocol/capabilities required by the methods in use.
5. Return `undefined` only for genuine non-Herdr startup. Once Herdr mode is selected, later transport failures should be surfaced rather than silently executing a command somewhere else.

#### Target tab and anchor pane

1. List tabs only in the discovered workspace.
2. Match the configured label exactly.
3. Treat duplicate exact labels as an ambiguity error rather than selecting unpredictably.
4. If `pi-shell` is absent, create it with `focus: false`, `cwd: ctx.cwd`, and retain the returned root pane as a permanent anchor.
5. If `pi-shell` already exists, find its reserved root-pane marker. If none exists, select one non-job pane once, mark it as the root, and never run commands in it.
6. Every sync or async shell command must split a new pane from that root. The root pane is control/anchor infrastructure only.
7. Label extension-owned job panes with a reserved prefix so they are never mistaken for the root after reload.
8. Cache the root pane ID only as a hint. Revalidate it before each split because Herdr IDs are live-resource IDs and may change or disappear.
9. Serialize root selection plus split, and retry discovery once if the root vanishes during the operation. Commands can run concurrently after their panes are created.

The tab label is configuration owned by the caller, not hard-coded in the library. This is the seam that lets later extensions target other tabs.

#### Reliable command runner

Do not infer completion or exit status from prompts or terminal text.

For each job:

1. Create a private temporary job directory containing a request file, append-only combined-output file, and atomic result sidecar.
2. Split a new pane from the target tab's anchor with the command cwd and `focus: false`.
3. Rename/mark the pane with a reserved job label.
4. Atomically inject an `exec ...runner... <request-file>` command into the pane.
5. The runner spawns the requested shell command, mirrors stdout/stderr to the pane for human visibility, appends arriving bytes to the output file for exact programmatic collection, and atomically writes `{ exitCode, signal, timestamps }` on completion.
6. The host tails the output file and calls `onData` as bytes arrive.
7. On result sidecar creation, flush remaining bytes and return the exit result.
8. The runner's use of `exec` makes it the pane's direct foreground lifecycle. When it exits, Herdr emits pane exit and normally removes the pane; the host also performs an idempotent close as defensive cleanup if the pane still exists.
9. On abort or timeout, close the pane to terminate its PTY process tree, wait for pane exit with a bounded grace period, and report cancellation/timeout distinctly.
10. Remove private job files after foreground completion. Managed jobs retain logs/status according to a bounded retention policy.

A sidecar is required because Herdr's pane-exit event has no exit code. Terminal output remains useful for people but is not the machine-readable source of truth.

### 3. Routed bash job provider

The bash package always registers one `type: "bash"` provider. For each start it validates whether Pi is currently running in usable Herdr context:

- **Validated Herdr:** resolve/create the current workspace's `pi-shell` tab and run in a new unfocused pane.
- **No valid Herdr context:** launch a managed local bash process directly.

The `pi-jobs` package removes `bash` from Pi's active model tools during every session start/reload while preserving all other active tools. It never registers a replacement named `bash`; `/bash-tool on|off` can explicitly toggle the still-registered tool, and `job({ type: "bash" })` remains the intended model-facing shell interface.

#### Explicit bash semantics

`type: "bash"` always means bash, independent of the user's configured login or pane shell.

- The local backend resolves/spawns `bash` directly with `-c`, explicit cwd/environment, detached process group, captured output, abort, and timeout handling.
- The Herdr pane receives only a fixed safely quoted runner launcher. The runner reads opaque `cmd` from the private request and explicitly spawns `bash -c`; the pane's configured shell never interprets the user command.
- If `bash` cannot be resolved, fail with a stable provider error. Never substitute another shell.

This matters because a Herdr pane may use zsh, fish, nushell, or another shell whose syntax differs from bash.

#### Managed bash lifecycle

- Sync bash waits and returns status/exit metadata, `outputPath`, and only the bounded head/tail output projection. The full bytes never cross job RPC or model context.
- A nonzero exit resolves normally with `status: "failed"`, `exitCode`, bounded output, and path. It is not a JavaScript rejection; callers branch on status. Validation, launch, transport, and provider-integrity failures still throw.
- Async bash promptly returns ID, status/result paths, and live append-only `output.log`.
- `job_list({ type: "bash" })` returns running or explicitly requested terminal metadata and paths.
- `job_stop` closes only the owned Herdr pane or terminates only the owned local process group.

There are no job read or wait operations. Tool descriptions show outer callers using Pi `read` and JavaScript callers using `node:fs/promises` on `outputPath`; a parent may poll and branch on a live async bash output file.

Herdr validation/fallback happens before launch. Once a Herdr job creates a pane or starts its runner, any failure is reported and the command is never retried locally.

Async bash jobs remain visible to outer or nested `job_list`/`job_stop`, survive unrelated work/reload according to final ownership policy, and persist their output/status without implying notification.

#### Root-only async completion messages

Only async root jobs—jobs started directly from the normal Pi context with no `parentJobId`—receive automatic completion delivery. Nested jobs never inject messages or wake the agent, whether they complete, fail, time out, are stopped explicitly, or are cascade-stopped.

A watcher follows every job for persistence and cleanup, but delivery is gated on root status. For an async root:

1. Flush final output and provider result sidecars.
2. Build the bounded type-specific completion projection plus full output path.
3. Persist/inject it with a unique delivery ID so reload/recovery cannot inject it twice.
4. Queue as `followUp` while the origin agent is active or use `triggerTurn: true` when idle.
5. Finalize provider resources idempotently.

A parent JavaScript flow surfaces child work only by explicitly incorporating child results, metadata, or output paths into its own returned value. If it does not, child completion remains visible only in artifacts and explicit `job_list` queries.

If session replacement begins before a root completes, stop/finalize it as `session_replaced` without delivery; never retain a completion for injection into another or later-resumed session. `/reload` is not replacement and preserves delivery state.

#### Fixed v1 bash/Herdr policy

There is no configuration file in v1. Use fixed behavior:

- target tab label `pi-shell`;
- split right at ratio `0.5`, without focus;
- resolve `bash` from the Pi process `PATH`;
- 5-second stop grace for local process termination and Herdr pane cleanup;
- retain all job history/artifacts until manual deletion.

Centralize these values as constants so later evidence can justify a configuration seam without leaking options throughout the providers.

## Error and lifecycle policy

- **Not in Herdr:** route bash jobs locally without warning.
- **Herdr markers present but validation fails:** warn once and route new bash jobs locally.
- **Herdr fails after a job has started:** report an explicit error and never rerun locally.
- **Target tab missing:** create `pi-shell` without focusing it and reserve its root pane as the permanent split anchor.
- **Root pane:** never execute a user/agent command in it; every sync and async invocation gets a new pane.
- **Duplicate target labels:** error with the matching tab IDs and require disambiguation/rename.
- **Pane creation succeeds but command launch fails:** close the pane and clean job files.
- **Abort/timeout:** close only the owned job pane, never the root or Pi pane.
- **`/reload`:** all providers keep live jobs through the process-global `JobManager`; the replacement adapter/providers reattach to child IPC, local process handles, or Herdr sidecars/panes and preserve exactly-once root delivery.
- **`/new`, `/resume`, `/fork`:** stop every job owned by the replaced session across JS, local bash, and Herdr bash; finalize as `session_replaced` and do not transfer ownership.
- **Completion delivery:** async roots notify exactly once for every terminal outcome when the origin remains available. Nested jobs never notify or wake; cascade-stopped descendants are not summarized automatically.
- **Completion wake-up:** root completion uses follow-up delivery during active work and triggers a model turn when the origin session is idle.
- **Pi quit:** stop every job across all providers and finalize as `host_exited`. On the next startup, reclaim any abandoned owned process/pane and finalize stale running manifests as `host_crashed`; never resume them.
- **Parent success:** async descendants survive independently as session-owned jobs; retain parent/ancestry metadata for inspection.
- **Parent failure/timeout/stop:** atomically close the lineage to new child starts, abort in-flight nested calls, and cascade-stop every active descendant across providers before finalizing the parent's terminal record. Stopping a child does not affect its parent or siblings; an async child failure does not cascade upward.
- **JavaScript process stop:** send `SIGTERM` to the owned process group, escalate to `SIGKILL` after 5 seconds, and atomically finalize.
- **Concurrent jobs:** the manager imposes no global concurrency/depth limit. Herdr target resolution/split is serialized, but execution is not.

## Platform scope

Version 1 supports Linux only. Detect unsupported platforms before registering the job toolset or deactivating standalone bash, and report a clear startup diagnostic rather than attempting degraded isolation. Do not claim macOS or Windows support until permission-model, process-group, artifact, socket, and lifecycle tests run there.

## Security and correctness

- Never construct a shell command by interpolating untrusted paths. Pass runner metadata through a JSON request file and quote only the fixed runner invocation with a tested platform-aware argument encoder.
- Keep `cmd` opaque. Local and Herdr runners pass it once to an explicitly spawned `bash -c`; only the fixed Herdr runner launcher is quoted for the pane's configured shell.
- Resolve cwd from each Pi tool invocation (`ctx.cwd`), not from extension-load-time `process.cwd()`.
- Restrict cleanup to extension-owned pane labels and job directories.
- Put bounds on captured output, retained job logs, wait durations, and stop grace periods.
- Avoid logging command contents by default; commands can contain secrets.
- Make all cleanup idempotent.

## Test plan

### Unified job-runtime tests

- Outer Pi tools and inner RPC wrappers use the same schemas and normalized results for `job`, `job_list`, and `job_stop`.
- The JS provider returns final values synchronously; async mode returns IDs and later injects exactly one completion.
- Nested JS→JS and JS→bash starts record parent/ancestry and cross the parent RPC boundary rather than spawning from the sandbox.
- Nested calls propagate cancellation, timeout, and caller identity; no manager concurrency/depth cap rejects starts.
- Intermediate results stay out of the Pi thread unless explicitly returned.
- Program crashes, serialization failures, runaway loops, and sandbox exits cannot crash Pi.
- Reload preserves live JS jobs and exactly-once completion state.
- Any console property access throws `ERR_JOB_CONSOLE_UNAVAILABLE`; child stdio is ignored.
- Complete SuperJSON envelopes persist as read-paginatable `output.yaml`; transcript output uses bounded middle truncation and includes the path.
- Source, manifests, event logs, diagnostics, output, hierarchy, and atomic result metadata remain inspectable.
- Promise/timer composition works without sleep or wait operations.
- Omitted timeout permits long runs; explicit timeout and sync abort kill/finalize the JS process tree.
- A sync JS job can delay and inspect `job_list`; no read/wait job operation exists.
- Validation/runtime/serialization/timeout/stop/IPC/fatal failures produce stable phase codes and source-mapped diagnostics.
- JavaScript can read/write files outside cwd, dynamically import `node:fs/promises`, and make HTTP requests with `fetch`/Node network modules.
- The same child cannot spawn subprocesses, create workers, load native addons, use FFI/WASI, or open the inspector under the permission model.

### Herdr library tests

Use a fake Unix-socket server as the production adapter's test counterpart and test through the public interface:

- NDJSON framing, partial reads, malformed JSON, error envelopes, disconnects, request timeout, and abort.
- Discovery with missing/stale env, failed ping, explicit caller pane, and server-derived workspace.
- Exact target-tab lookup, duplicate labels, missing-tab policies, and create-without-focus.
- Anchor filtering/revalidation and one retry after a stale pane.
- Concurrent split allocation.
- Runner stdout, stderr, interleaving, Unicode, empty output, nonzero exit, signal exit, large output, and atomic sidecar writes.
- Abort/timeout closes only the owned pane and performs bounded cleanup.
- Foreground cleanup and managed-job recovery/retention.

### Pi adapter tests

Use fake `ExtensionAPI`, context, and `HerdrJobHost` adapters:

- The standalone `bash` model tool is inactive after startup/reload, `/bash-tool on|off` toggles it without unregistering it, and the default shell path is `job({ type: "bash" })`.
- Outside Herdr, sync/async bash jobs use the local backend; inside validated Herdr they use fresh panes.
- Both backends explicitly launch `bash -c`, forward cwd/environment/timeout/cancellation, capture output, and normalize exit status.
- Managed async bash returns ID and live output path promptly; direct `read` inspects it and `job_list` reports status.
- Sync bash returns only bounded head/tail output plus metadata/path; `output.log` retains complete bytes.
- `job_stop` dispatches IDs to the correct JS or bash provider.
- Async root bash/JS completion is bounded and delivered exactly once across reload.
- Nested jobs of either type persist terminal state but never inject completion or wake the agent.
- JS, local bash, and Herdr bash all survive reload but stop on session replacement and Pi quit; crash recovery reclaims stale owned resources without resuming jobs.
- Pi work-tool wrappers remain absent inside JS, while unrestricted raw Node filesystem/network APIs are available.
- `user_bash` / `!command` is untouched and explicitly outside this change.
- Tool descriptions clearly explain output-path/direct-read and Promise/timer waiting.

### Opt-in live integration test

Against a disposable Herdr workspace/tab:

1. Run a short successful command and verify streamed output, exit code, pane disappearance, and no focus change.
2. Run a failing command and verify stderr/nonzero propagation.
3. Cancel a sleeping process and verify process-tree/pane cleanup.
4. Start a dev-server fixture, inspect its live output path through the direct `read` tool, stop it, and verify cleanup.
5. Run two commands concurrently and verify separate panes and results.

Never run this suite against the user's normal workspace by default.

## Implementation sequence

1. Resolve remaining unified-job grilling decisions and update this document.
2. Add `job-runtime` and `pi-jobs` workspace packages plus tests.
3. Implement the provider registry, process-global manager, JS sandbox RPC, and sync outer/inner `job`.
4. Add nested JS jobs, async lifecycle, `job_list`, `job_stop`, completion injection, cancellation, and reload recovery.
5. Verify identical schemas/results in normal Pi context and inside JS jobs.
6. Only after JavaScript jobs are stable, add the Herdr package and routed bash provider.
7. Implement typed Herdr transport, discovery, target-tab/root management, pane jobs, and local fallback.
8. Register the bash provider and test explicit `bash -c` on both backends; standalone `bash` deactivation and `/bash-tool on|off` are already supplied by `pi-jobs`.
9. Resolve Herdr configuration and add integration tests; do not alter `!command`.
10. Manually verify nesting, reload, session switching, cancellation, disconnects, and Pi quit across providers.

## Decisions to grill

1. **Resolved:** JavaScript jobs are step one; the Herdr bash provider integrates in step two.
2. **Resolved:** normal Pi and inner JavaScript contexts receive the same `job`, `job_list`, and `job_stop`; direct work tools stay outside JavaScript.
3. **Resolved:** standalone model `bash` is inactive by default but remains registered and user-toggleable through `/bash-tool on|off`; `job.type = "bash"` is the intended model shell API and routes to validated Herdr or managed local bash once step two is installed.
4. **Resolved:** planning/review are ordinary nested job compositions, not privileged globals.
5. **Resolved/out of scope:** a future Herdr `pi-sub` provider may add another job type; current work preserves the provider seam only.
6. **Resolved:** v1 has only the three-operation job toolset, persisted output, and lifecycle diagnostics; no convenience read/wait/sleep helpers.
7. **Resolved:** each JS job runs in a separate permission-constrained Node child with inner `node:vm`, parent-host RPC, unrestricted filesystem/network, and denied subprocess/worker/addon/FFI/WASI/inspector capabilities.
8. **Resolved:** artifacts live under `~/.pi/pi-execute/<cwd-slug>/<session-time>-<session-id>/<execution-time>-<job-id>`, omit duplicate timestamps, and persist until manually deleted.
9. **Resolved:** async descendants survive successful parent completion, but parent failure/timeout/stop cascade-stops all descendants; child termination never cascades upward or sideways.
10. **Resolved:** JS and bash share one ID namespace and `job`/`job_list`/`job_stop` surface, with type-discriminated records.
11. **Resolved:** there are no wait operations; use Promise/timer composition and `job_list`.
12. **Resolved:** missing `pi-shell` is created unfocused, one root remains, and every bash job gets a new pane.
13. **Resolved:** only async root jobs notify/wake the originating session; nested jobs stay silent unless the parent explicitly returns their information.
14. **Resolved:** every provider survives `/reload`, stops on `/new`/`/resume`/`/fork`/Pi quit, and reclaims stale owned resources without resuming after crashes.
15. **Resolved/out of scope:** leave Pi's existing `!command` / `user_bash` behavior untouched.
16. **Resolved:** no config, compact self-shell renderer, local unpublished packages, Linux-only, and full diagnostics across providers.
17. **Resolved:** `job` has no default timeout; explicit positive timeout uses seconds.
18. **Resolved:** console throws guidance, stdio is ignored, output comes from return, no read/wait job operations exist, and JS may use raw filesystem/network APIs.
19. **Resolved:** transcript output is limited to 2,000 lines/50 KiB with prefix + `[truncated]` + suffix; `output.yaml` stays complete.
20. **Resolved:** `output.yaml` is deterministic YAML containing the complete circular-safe SuperJSON envelope.
21. **Resolved:** no manager-level concurrency or nesting-depth limit.
22. **Resolved:** default `job_list` returns all running plus current-session non-running count; explicit terminal history is newest-first in opaque-cursor pages of 50.
23. **Resolved:** JS `job_stop` uses `SIGTERM`, then `SIGKILL` after 5 seconds; provider stop is idempotent.
24. **Resolved:** root async terminal results notify exactly once when the origin remains available; nested/cascade-stopped jobs never notify automatically.
25. **Resolved:** all v1 job/provider policies are fixed with no configuration file.
26. **Resolved:** failures persist full normalized phase/code/message/cause/stack/exit diagnostics mapped to `source.js`.
27. **Resolved:** v1 supports Linux only.
28. **Resolved:** job tools render as unboxed one-row status lines; `/job-details on|off` optionally shows full submitted JavaScript/bash command lines and defaults off after startup/reload.
29. **Resolved:** packages are local workspace-only with no publication setup.
30. **Resolved:** the direct `execute` tool and separate bash/execution lifecycle functions are removed; nested jobs are allowed through the shared toolset.
31. **Resolved:** the bash provider explicitly launches `bash -c` in both local and Herdr modes; it never executes agent commands through the user's configured pane shell.
32. **Resolved:** there is no built-in child-job notification or cascade summary; surfacing child work is the parent JavaScript flow's responsibility.
33. **Resolved:** bash/Herdr uses fixed `pi-shell`, right/0.5 split, PATH-resolved bash, 5-second stop grace, and manual-only artifact deletion.
34. **Resolved:** sync bash returns bounded head/tail output plus metadata and `outputPath`; complete bytes remain only in `output.log`.
35. **Resolved:** nested sync JavaScript returns bounded YAML head/tail plus metadata and `output.yaml`; the complete typed return value is not injected into the parent job.
36. **Resolved:** nonzero bash exits resolve with failed status/exit code/output metadata rather than throwing; infrastructure/provider errors still throw.
37. **Resolved:** completed/failed/timed-out/stopped are resolving terminal records for every provider; only request/provider launch/transport/integrity errors throw.
38. **Resolved:** explicit non-running/all history uses newest-first pages of 50 with an opaque continuation cursor.
39. **Resolved:** `job` has no cwd option; roots use Pi cwd, nested jobs inherit it, and bash directory changes are explicit in `cmd`.
40. **Resolved:** JavaScript jobs have unrestricted filesystem read/write, unrestricted network, dynamic ESM imports, and fetch; stronger data isolation is explicitly not a goal.

## Non-goals for v1

- A general terminal emulator or replacement for Herdr.
- Exposing the entire Herdr protocol as a pass-through interface.
- Interactive full-screen commands such as editors through `job({ type: "bash" })`.
- Moving commands between workspaces based on cwd heuristics; the calling pane's Herdr workspace is authoritative.
- Silently re-executing failed Herdr commands through local bash.
- Implementing the future `pi-sub` tab, Pi subagent launch, or subagent lifecycle capabilities.
- Changing, disabling, or rerouting Pi's `!command` / `user_bash` behavior.
- macOS or Windows support in v1.
