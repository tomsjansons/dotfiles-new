# Herdr-backed Pi shell plan

Status: **provisional; implementation must not start until the grilling questions are resolved.**

## Architectural reset

Herdr-backed bash is now **step two**, not the foundation. The design has two ordered product steps and three reusable modules.

### Tool-plane split

The model-facing tool surface is intentionally divided by role:

- **Work tools stay direct in the agent context.** `read`, `write`, `edit`, `vent`, and similar tools remain ordinary Pi tools. The model calls them normally, so their results and mutations remain visible in the conversation and retain their native renderers, safety hooks, and semantics.
- **Orchestration, execution, and control capabilities live behind `execute`.** Subagent coordination, long-running processes, waits, result inspection, planning, review orchestration, and lifecycle control are JavaScript globals available inside `execute`, not separate model-facing tool definitions.
- **Bash is the sole dual-surface exception.** Simple foreground bash remains a normal direct Pi tool. The same Herdr-backed bash module also registers sync/async bash and job-control functions inside `execute`.

This means step one does not try to bridge every installed Pi tool. It defines an explicit orchestration-capability registry. Extensions opt capabilities into code execution deliberately; direct work tools remain outside it.

### Step one: programmatic tool execution

Build a provider-agnostic Pi `execute` extension that runs agent-authored JavaScript and exposes approved orchestration capabilities as awaitable globals.

- `execute({ mode: "sync", js })` runs the program now and returns its final value/output.
- `execute({ mode: "async", js })` returns an execution ID immediately, continues in the background, and injects its final result into the originating Pi thread with automatic wake-up.
- Execution lifecycle controls are code-only globals for listing, waiting on, or stopping async executions. Program output is inspected through the persisted file path using Pi's normal direct `read` tool; there is no `execution_read` code capability.
- A reusable callable-tool registry/RPC seam lets orchestration-oriented extensions contribute functions without exposing them as separate direct tools.

### Step two: Herdr-backed bash

Build the reusable Herdr library and Pi bash extension. It exposes two interfaces over the same implementation:

1. A direct, foreground-only Pi `bash` tool for simple work commands.
2. Code-only `bash`, `bash_list`, `bash_read`, `bash_wait`, and `bash_stop` globals for orchestration. The code-only `bash` supports both sync and async modes.

Every command still runs in a fresh pane under the current workspace's `pi-shell` tab.

Host tool wrappers should be asynchronous because calls cross an RPC seam. The example workflow becomes:

```ts
const jobId = await bash("async", "pnpm dev");
while (!(await bash_read(jobId)).match(/ready/)) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
return { jobId, ready: true };
```

The exact convenience signatures remain open, but nested host-tool calls should consistently be awaited.

A future, out-of-scope subagent capability will reuse the Herdr library: create/use a configurable `pi-sub` tab, open a pane, launch Pi there with the subagent instructions, and expose its lifecycle through code orchestration. The current task must keep Herdr primitives generic enough for that adapter but must not implement subagents.

## Confirmed platform facts

- Herdr provides a newline-delimited JSON protocol over `HERDR_SOCKET_PATH`; its own client opens a connection, writes one JSON request plus `\n`, and reads one JSON response line ([source](https://github.com/ogulcancelik/herdr/blob/299dd4163a96381ec2d8e5bde13d7ba6d6432373/src/api/client.rs#L32-L62), [wire framing](https://github.com/ogulcancelik/herdr/blob/299dd4163a96381ec2d8e5bde13d7ba6d6432373/src/api/client.rs#L207-L223)).
- `tab.create` returns both the tab and its root pane, so a newly created target tab can retain a dedicated anchor pane ([source](https://github.com/ogulcancelik/herdr/blob/299dd4163a96381ec2d8e5bde13d7ba6d6432373/src/api/schema/response.rs#L87-L96)).
- `pane.split` creates a real shell pane and accepts an explicit target pane, cwd, environment, focus flag, direction, and ratio ([schema](https://github.com/ogulcancelik/herdr/blob/299dd4163a96381ec2d8e5bde13d7ba6d6432373/src/api/schema/panes.rs#L8-L23), [implementation](https://github.com/ogulcancelik/herdr/blob/299dd4163a96381ec2d8e5bde13d7ba6d6432373/src/app/api/panes.rs#L33-L124)).
- `pane.run` is only an atomic text-plus-Enter injection; it does not return command output or an exit code ([source](https://github.com/ogulcancelik/herdr/blob/299dd4163a96381ec2d8e5bde13d7ba6d6432373/src/cli/pane.rs#L929-L942)).
- `pane.wait_for_output` polls terminal text for a marker and returns the matching read, but it is not process completion tracking ([source](https://github.com/ogulcancelik/herdr/blob/299dd4163a96381ec2d8e5bde13d7ba6d6432373/src/api/wait.rs#L20-L126)).
- Herdr emits `pane.exited`, but that public event does not carry the process exit code ([source](https://github.com/ogulcancelik/herdr/blob/299dd4163a96381ec2d8e5bde13d7ba6d6432373/src/api/schema/events.rs#L493-L501)).
- Pi's `createBashTool` accepts a `BashOperations` adapter with streamed `onData`, abort, timeout, cwd, environment, and final exit code. Reusing it preserves Pi's bash schema, truncation, error behavior, and renderer contract instead of reimplementing those details.
- Pi's built-in bash schema has only `command` and optional `timeout`; it has no first-class async/background option. It always waits for the spawned shell to exit while streaming stdout/stderr. Shell syntax such as `cmd &` may let the shell exit while a descendant continues, but Pi provides no job ID, status/read/stop lifecycle, and output arriving after the tool settles is no longer a reliable managed stream.
- This dotfiles repo already has a `hashline-tools` extension that overrides `bash`, so registration order and renderer ownership must be handled deliberately rather than assumed.
- Pi 0.80.3 does **not** publicly expose registered tool executors. `pi.getAllTools()` returns metadata only; the internal session has full definitions, but `ExtensionAPI` has no `getToolDefinition()` or invoke method. Step one therefore cannot transparently call every installed Pi tool through supported interfaces without an explicit callable-tool registry, recreated adapters, or a Pi change/private bridge.
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
├── tool-program-runtime/            # reusable JS execution + host-tool RPC
│   ├── src/
│   │   ├── executor.ts
│   │   ├── callable-tools.ts
│   │   ├── rpc.ts
│   │   ├── jobs.ts
│   │   └── types.ts
│   └── test/
├── pi-execute/                      # step-one Pi adapter
│   ├── src/
│   │   ├── index.ts
│   │   ├── artifacts.ts             # source, event log, result persistence
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
└── herdr-pi-shell/                  # step-two Pi + callable-tool adapter
    ├── src/
    │   ├── index.ts
    │   ├── bash-operations.ts
    │   ├── bash-job-tools.ts
    │   ├── callable-bash.ts
    │   └── completion-messages.ts
    └── test/
```

All names are provisional. Add packages to the existing pnpm workspace without disturbing unrelated local changes.

These are local dotfiles workspace packages only. Mark them private, add no npm publication/release setup, and make no public compatibility commitment.

## Module design

### 1. Programmatic execution module

The external interface is one deep `execute` module plus a small capability-registration seam.

#### Pi tool interface

```ts
execute({
  mode: "sync" | "async",  // default sync
  js: string,
  timeout?: number,              // seconds; no default
})
```

A sync execution persists the complete rendered return value, then returns a bounded head-and-tail projection plus its full output path. An async execution returns an execution ID and expected output path immediately; completion is injected exactly once into its originating Pi thread with the same bounded projection and path.

Like standard Pi bash, omission of `timeout` means no deadline. A positive explicit timeout is measured in seconds. Sync execution still obeys the Pi tool-call abort signal; async execution is stopped explicitly through `execution_stop()` or session lifecycle teardown.

Step one has no configuration file. The artifact root, transcript limits, 5-second stop grace, lack of a default timeout, and lack of a concurrency limit are fixed v1 behavior. Keep these values centralized as named constants so a later configuration seam does not leak through the runtime internals.

Like `pi-dynamic-workflows`, both modes go through one `ExecutionManager`: `start()` returns an ID and detached promise; `runSync()` creates the same managed run but awaits it. The manager owns status transitions, output, final value, error, abort controller, session identity, and completion events.

Keep the live `ExecutionManager` in a process-global service keyed with `Symbol.for(...)`, rather than inside one reloadable extension instance. A replacement `pi-execute` adapter reattaches its delivery and rendering hooks after `/reload`; pending completion events remain queued in the service until attachment. This mirrors standard Pi bash, which is not aborted by `/reload`.

Execution controls are injected globals rather than additional direct Pi tools:

- `execution_list()`: by default, return metadata for every currently running execution plus only the total number of non-running executions belonging to the current session. An explicit non-running query returns current-session terminal entries (completed, failed, stopped, timed out, interrupted, and lifecycle-terminated) with artifact/output paths; historical sessions remain filesystem artifacts rather than implicit list results.
- `execution_wait(id, { timeout? })`: wait only for terminal completion and return status, timing, artifact directory, and `output.yaml` path. The optional timeout is in seconds, has no default, and times out only the wait—not the target execution.
- `execution_stop(id)`: cancel in-flight nested host calls, send `SIGTERM` to the owned child process group, escalate to `SIGKILL` after 5 seconds if still alive, await finalization, and return terminal metadata plus the output path. Stopping an already terminal execution is idempotent.

There is deliberately no `execution_read()` capability. The agent receives the full output filename from `execute`, completion delivery, list, or wait metadata and reads it using Pi's normal direct `read` tool. This keeps file inspection in the direct-work plane.

`execution_wait` rejects waiting on the current execution with `ERR_EXECUTION_WAIT_DEADLOCK`. Do not add arbitrary event predicates initially; revisit only if real orchestration programs repeatedly need them.

#### Minimal TUI renderer

Use a custom renderer, but keep v1 deliberately tiny. Render only mode, execution ID, status, and elapsed/final duration. While a synchronous execution is running, issue throttled partial updates only when status or displayed duration changes. Do not render source, output previews, errors, or artifact paths in either collapsed or expanded TUI state yet.

This is presentation-only: the model-facing final tool content and async completion still contain the bounded output/diagnostic projection and `output.yaml` path. Full source and output remain in artifacts. Iterate on richer TUI presentation only after observing real usage.

#### Callable-tool seam

```ts
type CallableTool = {
  name: string;
  description: string;
  inputSchema: TSchema;
  invoke(input: unknown, context: NestedCallContext): Promise<unknown>;
};

interface CallableToolRegistry {
  register(tool: CallableTool): Disposable;
  list(): CallableToolMetadata[];
  invoke(name: string, input: unknown, context: NestedCallContext): Promise<unknown>;
}
```

The JavaScript runtime receives generated async wrappers from this registry and never imports extension implementations directly. Production invokes capabilities over RPC; tests use in-memory callable tools.

The registry tracks caller identity, parent execution ID, nested call ID, cancellation, timeout, and whether a capability is allowed from code. It does not impose a global execution concurrency limit; individual capability providers may still enforce limits required by their own backends. Recursive creation of another `execute` run is blocked by default, while `execution_list/wait/stop` may control existing runs.

Generate plain named globals (`bash`, `bash_read`, `subagent`, etc.) from the explicit orchestration registry rather than exposing a generic bridge to all Pi tools. A generic internal dispatcher may back the wrappers, but `read`, `write`, `edit`, `vent`, and other work-plane tools are deliberately absent.

Planning and review are orchestration programs composed from primitives such as subagent execution, bash/process control, waits, branching, loops, and aggregation. They are not privileged `plan()` or `review()` globals in the runtime.

#### Runtime isolation

Run each `execute` invocation in its own Node child process. Start it with Node's permission model enabled and grant only read access to the fixed runtime bootstrap; do not grant filesystem writes, workspace reads, network access, subprocesses, workers, native addons, FFI, WASI, or inspector access.

Inside that permission-constrained child, create a fresh `node:vm` context containing generated async capability wrappers, standard language globals, `Promise`, and standard timers such as `setTimeout`/`clearTimeout`. Do not add custom convenience helpers initially.

Do not provide a working console or output helper. Bind `console` to a hostile proxy whose property access or reflective use throws a distinct `ConsoleUnavailableError` with code `ERR_EXECUTE_CONSOLE_UNAVAILABLE`. Its message tells the agent that console output is unavailable and that programs output data by explicitly returning it, for example `return value`.

Spawn with `stdio: ["ignore", "ignore", "ignore", "ipc"]`. Child stdin, stdout, and stderr are neither inherited nor piped into the Pi process. Expected results, normalized errors, lifecycle events, and capability RPC use typed IPC only. Fatal failures that cannot send IPC are represented by the child's exit code or signal.

The parent Pi extension owns the RPC dispatcher and `ExecutionManager`. It validates nested calls, invokes registered host capabilities, records lifecycle/debug events, persists complete output, propagates cancellation, and kills the child on timeout, stop, IPC failure, or session teardown policy. A CPU-bound infinite loop can freeze only its child, not Pi.

`node:vm` is therefore an ergonomics/namespace layer, not the security boundary. If code escapes the VM, it still lands in a separate Node process constrained by `--permission`, with ignored stdio. Tests must prove denied filesystem, network, child-process, worker, and addon access.

Intermediate nested-tool results remain inside the child. Only the explicitly returned final value, normalized errors, bounded lifecycle telemetry, and artifact paths enter the Pi transcript.

Validate syntax before spawning, wrap the accepted body as an async program so top-level `await` and `return` work, then await its promise. No `meta` header, workflow DSL, phase machinery, hooks, or built-in planning/review framework is required.

#### Output capture and transcript truncation

A program emits output only through its final return value. Use pinned SuperJSON 2.2.5, bundled into the fixed child bootstrap, to serialize supported values—including circular/repeated references, `undefined`, `BigInt`, `Date`, `RegExp`, `Set`, `Map`, `Error`, URL, and supported typed arrays. Encode the complete `{ json, meta? }` envelope as deterministic YAML in `output.yaml` using a pinned YAML emitter. Configure multiline strings as block scalars and wrap long scalar output so the normal line-oriented `read` tool can paginate it; parsing the YAML and passing the envelope to `SuperJSON.deserialize()` must reconstruct the value. Reject unsupported functions, unregistered symbols/classes, or serialization failures with `ERR_EXECUTE_RESULT_NOT_SERIALIZABLE`; never silently omit them. A normalized execution failure is likewise persisted as a full SuperJSON envelope while `result.json` records failure status.

Never place unbounded output in model context. Match Pi's existing tool-output limits: at most 2,000 lines and 50 KiB of UTF-8 text, with either limit independently triggering middle truncation. Reserve space for a literal `[truncated]` marker, then split the remaining line and byte budgets approximately evenly between a prefix and suffix. Preserve UTF-8 boundaries; an individual oversized line may be cut so both the beginning and end remain visible. Report omitted line/byte counts as result metadata outside the projection.

Always show the absolute `output.yaml` path. The file contains the complete YAML-encoded SuperJSON envelope, never the transcript-truncated projection. The agent uses its normal direct `read` tool when it needs the full output. Synchronous partial rendering shows status/duration only because there is no console stream; the bounded output appears when execution completes.

Async startup returns the execution ID, artifact directory, and expected `output.yaml` path. Individual lifecycle events do not wake the agent. Completion delivery includes status, duration, bounded head/tail output, truncation statistics, and the full output path.

#### Failure diagnostics

Every failure writes a normalized diagnostic value through the same SuperJSON-to-YAML output path. Include the phase (`validation`, `bootstrap`, `execution`, `serialization`, `timeout`, `stop`, or `host_lifecycle`), error name, stable code, message, complete stack, recursively serializable cause, and child exit code/signal when applicable. Preserve non-`Error` thrown values explicitly rather than coercing them to an unhelpful string.

Compile the wrapper with the persisted absolute `source.js` filename and compensate for wrapper lines so syntax and runtime stack locations point to agent-authored line numbers. Keep `wrapped.js` for diagnosing transformation offsets. Fatal child failures that cannot report a JavaScript stack still record process exit/signal and the last acknowledged lifecycle phase.

The permanent `output.yaml` and `result.json` contain full diagnostics. The Pi tool result and async completion use the same 2,000-line/50-KiB middle-truncation projection as successful output.

#### Execution artifacts and debugging

Persist the exact JavaScript source before spawning so every sync or async run can be diagnosed later. Each execution artifact directory should contain:

- `source.js`: exact model-supplied snippet;
- `manifest.json`: execution/session IDs, mode, cwd, timestamps, runtime version, status, limits, and registered capability versions;
- `events.jsonl`: append-only state-transition, nested-call, runtime diagnostic, and cancellation events;
- `output.yaml`: complete YAML encoding of the SuperJSON envelope for the returned value or normalized failure;
- `result.json`: atomic status, type/error metadata, output statistics, and `output.yaml` reference;
- optionally `wrapped.js`: generated async wrapper for debugging runtime transformation issues.

Execute results and lifecycle metadata expose the execution ID, artifact directory, and full output path. Artifact writes are parent-owned; the sandbox child receives source over IPC and has no workspace/artifact filesystem permission.

Store artifacts under Pi's global directory, not the system temp directory:

```text
~/.pi/pi-execute/
└── <cwd-slug>/
    └── <session-timestamp>-<session-id>/
        └── <execution-timestamp>-<execution-id>/
            ├── source.js
            ├── manifest.json
            ├── events.jsonl
            ├── output.yaml
            └── result.json
```

Current Pi session headers keep `id`, `timestamp`, and `cwd` as separate fields; the ID itself is a UUID and contains neither a readable timestamp nor cwd. Therefore include a path-safe cwd slug and prefix the session timestamp. If a future session ID already contains a readable normalized timestamp, do not duplicate that session timestamp prefix. Execution directories always pair their start timestamp with execution ID unless the generated execution ID itself adopts a readable timestamp-bearing format.

Use Pi's existing cwd-slug convention where practical (for example `/home/toms/.dotfiles` becomes `--home-toms-.dotfiles--`). Normalize timestamps for path safety. Execute results and lifecycle metadata expose the full artifact and output paths.

Execution history and artifacts have no automatic retention deadline or size-based pruning. Keep them indefinitely until the user manually deletes them. The extension may provide inspection and explicit cleanup commands later, but must never silently remove completed artifacts.


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

### 3. Herdr Pi extension

#### Dual-surface bash

When Herdr discovery succeeds:

1. Register a direct Pi `bash` override with Pi's existing `command` plus optional `timeout` schema. Direct bash is always foreground/sync; it is the work-plane exception and should feel compatible with Pi's built-in tool.
2. Delegate direct execution to `createBashTool(ctx.cwd, { operations })`, where `BashOperations.exec()` calls `HerdrJobHost.run()`. Preserve Pi streaming, truncation, full-output files, timeout wording, and nonzero-exit behavior.
3. Separately register code-only orchestration capabilities with the callable-tool registry:
   - `bash(mode, command, options?)`, where mode is `"sync" | "async"`;
   - `bash_list()`;
   - `bash_read(jobId, options?)`;
   - `bash_wait(jobIds, condition?)`;
   - `bash_stop(jobId, options?)`.
4. Register the direct override during `session_start`, after factory-time tool registration, so it deliberately supersedes the existing hashline bash override in Herdr mode.
5. Reuse or preserve the compact hashline direct-bash renderer if practical. Code-only calls return normalized JavaScript values and do not render individual nested calls into the main transcript.
6. `!command`, if routed through Herdr, remains foreground/sync.

When discovery does not succeed:

- Do not replace direct Pi bash; the currently configured implementation remains active.
- Do not register Herdr bash capabilities with `execute`.
- Do not intercept `user_bash`.

#### Code-only bash lifecycle

The orchestration globals have these semantics:

- `bash("sync", command, options?)` waits and returns `{ output, exitCode, ... }`.
- `bash("async", command, options?)` returns a job ID promptly while its pane keeps running.
- `bash_list()` lists running and recently completed jobs.
- `bash_read(id)` reads running or retained completed output.
- `bash_wait(...)` coordinates exit/output/readiness conditions; exact multi-job semantics remain to grill.
- `bash_stop(id)` interrupts, then force-closes after a grace period.

These functions are documented in the `execute` tool's generated JavaScript interface, not added as direct Pi tools. Async bash jobs remain visible to later `execute` programs and survive unrelated agent work and extension reload.

#### Automatic async completion messages

Each async job records its originating Pi session path/ID and tool call ID. A watcher follows the job independently of whether the agent calls any job tool. On completion:

1. Flush the final output and exit sidecar.
2. Build a bounded completion message containing job ID, command summary, cwd, duration, exit code/signal, and the tail of combined output. Include the retained-log path when truncated.
3. Persist/inject it as a custom Pi message associated with the originating thread, with a unique delivery ID so reload/recovery cannot inject it twice.
4. If the originating agent is currently active, queue it with `deliverAs: "followUp"` so it does not interrupt an in-flight tool batch. If idle, inject with `triggerTurn: true` so the model receives and can act on the result immediately.
5. Close the completed job pane idempotently and retain job metadata/output for the configured history window so later code can call `bash_list()` and `bash_read()`.

If the user switches Pi sessions before completion, do not contaminate the newly active thread. Retain the undelivered completion against its origin session and inject it when that session is active again; surface a UI notification separately if useful.

#### Configuration

Minimum configuration:

```ts
type HerdrPiShellConfig = {
  tabLabel: string;                 // default "pi-shell"
  splitDirection: "right" | "down";
  splitRatio?: number;
  asyncRetentionMs: number;
  stopGraceMs: number;
};
```

Recommended precedence:

1. Explicit options passed to the extension factory (enables reuse/composition).
2. Trusted project config.
3. User config.
4. Environment variables for simple overrides.
5. Defaults.

The exact config file names and whether project config is needed in v1 remain grilling decisions.

## Error and lifecycle policy

- **Not in Herdr at startup:** preserve existing Pi bash with no warnings.
- **Herdr environment is present but ping/current-pane validation fails:** show one startup warning and preserve existing bash; do not half-enable Herdr tools.
- **Herdr fails after a job has started:** return an explicit transport/lifecycle error. Never silently rerun the command locally, because commands may have side effects.
- **Target tab missing:** create `pi-shell` without focusing it and reserve its root pane as the permanent split anchor.
- **Root pane:** never execute a user/agent command in it; every sync and async invocation gets a new pane.
- **Duplicate target labels:** error with the matching tab IDs and require disambiguation/rename.
- **Pane creation succeeds but command launch fails:** close the pane and clean job files.
- **Abort/timeout:** close only the owned job pane, never the root or Pi pane.
- **JavaScript `/reload`:** keep execution children and their process-global `ExecutionManager` alive; the replacement extension adapter reattaches to it and drains pending completion events exactly once.
- **JavaScript `/new`, `/resume`, `/fork`:** terminate executions owned by the replaced session, finalize them as `session_replaced` with the specific reason, and do not transfer them to the new session. This mirrors standard Pi bash.
- **Herdr `/reload`, `/new`, `/resume`, `/fork`:** rebuild in-memory handles from job sidecars and live pane labels; final async-job ownership policy remains a step-two decision.
- **Completion delivery:** every async terminal outcome—completed, failed, timed out, or explicitly stopped—injects exactly one notification into the originating available session, never whichever session happens to be active later. Session replacement and Pi quit finalize artifacts without attempting delivery to the disappearing session.
- **Completion wake-up:** use follow-up delivery during active work and automatically trigger a model turn when the originating session is idle.
- **Pi quit:** terminate every running JavaScript execution child, finalize its artifact as `host_exited`, and do not attempt to resume it. On the next startup, any manifest still marked running without a live owner is finalized as `host_crashed`. Herdr-owned async process policy remains a separate step-two decision.
- **JavaScript stop:** abort nested capability calls first, terminate only the target execution's process group with `SIGTERM`, escalate to `SIGKILL` after 5 seconds, and atomically finalize status/artifacts after exit. No cooperative cancellation global is exposed inside the VM.
- **Concurrent tool calls:** each receives a separate pane and job directory; target resolution/split is serialized, execution is not.

## Platform scope

Version 1 supports Linux only. Detect unsupported platforms before registering `execute` or replacing bash, and report a clear startup diagnostic rather than attempting degraded process isolation. Do not claim macOS or Windows support until permission-model, process-group termination, artifact, socket, and lifecycle tests run there.

## Security and correctness

- Never construct a shell command by interpolating untrusted paths. Pass runner metadata through a JSON request file and quote only the fixed runner invocation with a tested platform-aware argument encoder.
- Keep the user's command as opaque text and execute it once through the configured shell.
- Resolve cwd from each Pi tool invocation (`ctx.cwd`), not from extension-load-time `process.cwd()`.
- Restrict cleanup to extension-owned pane labels and job directories.
- Put bounds on captured output, retained job logs, wait durations, and stop grace periods.
- Avoid logging command contents by default; commands can contain secrets.
- Make all cleanup idempotent.

## Test plan

### Programmatic execution tests

- Generated wrappers invoke registered capabilities with validated inputs and normalized outputs.
- Sync programs return final values; async programs return IDs and later inject exactly one completion.
- Nested calls propagate cancellation, timeout, and caller identity; starting multiple top-level executions is not rejected or queued by an extension-level concurrency cap.
- Intermediate results stay out of the Pi thread unless explicitly returned.
- Program crashes, serialization failures, runaway loops, and sandbox exits cannot crash Pi.
- Session reload recovers async programs and exactly-once completion state.
- Any access to a `console` property throws `ERR_EXECUTE_CONSOLE_UNAVAILABLE` with return-value guidance; child stdio is ignored.
- Complete SuperJSON envelopes, including circular returns and failures, are persisted as deterministic, read-paginatable `output.yaml`; transcript output is independently bounded by lines and bytes, middle-truncated, and includes the full path.
- Exact source, manifest, lifecycle event log, diagnostics, output, and atomic result metadata remain inspectable after execution.
- Standard Promise/timer composition works without a custom `sleep()` helper.
- Omitting `timeout` permits a run longer than any arbitrary default; an explicit timeout and sync abort both kill the child process tree and finalize its artifact.
- `execution_wait` returns completion metadata, leaves the target running when its own optional timeout expires, and rejects self-waits deterministically.
- Validation, runtime, serialization, timeout, stop, IPC, and fatal-child failures produce phase-specific stable codes, full artifact diagnostics, and source-mapped user line numbers where a JavaScript stack exists.

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

- Outside Herdr, direct Pi bash remains unchanged and no Herdr code capabilities are registered.
- Inside Herdr, direct Pi bash is sync-only and the code runtime receives sync/async bash lifecycle globals.
- Direct sync mode forwards cwd, command, environment, timeout, signal, output chunks, and exit code through `BashOperations`.
- Code async mode returns promptly, leaves the process running, and returns a usable job ID.
- Code can read a running job, perform unrelated orchestration, and read it again after completion.
- Bash completion messages include bounded final output and are delivered exactly once to the originating session, including across extension reload.
- Work-plane tools such as read/write/edit/vent are not exposed in the code runtime.
- An idle originating agent is automatically awakened exactly once; an active agent receives completion as a follow-up.
- `user_bash` uses Herdr only if its separately chosen foreground semantics permit it.
- Prompt metadata clearly explains the direct-work versus code-orchestration split.

### Opt-in live integration test

Against a disposable Herdr workspace/tab:

1. Run a short successful command and verify streamed output, exit code, pane disappearance, and no focus change.
2. Run a failing command and verify stderr/nonzero propagation.
3. Cancel a sleeping process and verify process-tree/pane cleanup.
4. Start a dev-server fixture, wait for readiness, read logs, stop it, and verify cleanup.
5. Run two commands concurrently and verify separate panes and results.

Never run this suite against the user's normal workspace by default.

## Implementation sequence

1. Resolve the step-one grilling decisions and update this document.
2. Add the program-runtime and `pi-execute` package skeletons plus tests.
3. Implement the callable-tool registry, sandbox RPC, and sync `execute`.
4. Add async execution lifecycle, completion injection, cancellation, and recovery.
5. Register execution lifecycle controls as code-only capabilities and verify that no extra direct control tools appear.
6. Only after step one is stable, add the Herdr package skeleton.
7. Implement typed Herdr socket transport, discovery, target-tab/root management, and pane jobs.
8. Register Herdr bash as a direct sync Pi tool plus code-only sync/async orchestration capabilities.
9. Resolve renderer/config compatibility and add integration tests.
10. Manually verify reload, session switching, cancellation, disconnects, and Pi quit behavior across both execution layers.

## Decisions to grill

1. **Resolved:** programmatic JavaScript execution is step one; Herdr-backed bash integrates in step two.
2. **Resolved:** direct work tools remain in normal Pi context; only explicit orchestration/execution/control capabilities are callable from code.
3. **Resolved:** bash is dual-surface—direct sync for simple work, code-only sync/async plus lifecycle controls for orchestration.
4. **Resolved:** planning and review are ordinary JavaScript compositions over smaller orchestration primitives, not first-class privileged globals.
5. **Resolved/out of scope:** subagents will be a future Herdr capability provider using a `pi-sub` tab and Pi-in-pane execution; the current task only preserves the necessary generic Herdr seams.
6. **Resolved:** step one ships JavaScript execution, lifecycle debugging, persisted full output, and code-only list/wait/stop controls; step two adds Herdr bash. No custom convenience helpers are added initially.
7. **Resolved:** each execution runs in a permission-constrained Node child with an inner `node:vm`; host capabilities cross IPC and the parent can kill the child.
8. **Resolved:** artifacts live under `~/.pi/pi-execute/<cwd-slug>/<session-time>-<session-id>/<execution-time>-<execution-id>`, with duplicate readable timestamps omitted, and persist until manually deleted.
9. Parent/child lifecycle when async `execute` starts async bash jobs or other background work.
10. Whether execution and bash jobs use separate IDs/control functions or a shared generic job namespace.
11. **Resolved for step one:** `execution_wait` waits for terminal completion only, with an optional wait-only timeout and self-deadlock rejection; richer conditions are deferred.
12. **Resolved:** missing `pi-shell` is created without focus, one root is retained, and every command gets a new pane.
13. **Resolved:** completion wakes the originating idle agent automatically.
14. **Partially resolved:** JavaScript executions mirror standard Pi bash—survive `/reload`, terminate on `/new`, `/resume`, `/fork`, and quit; stale manifests are finalized rather than resumed. Herdr async-job behavior remains open.
15. Whether `!command` uses Herdr panes.
16. **Resolved for step one:** no config file, minimal renderer, local-only unpublished workspace packages, Linux-only scope, and full normalized failure diagnostics. Herdr-specific config/rendering remains open for step two.
17. **Resolved:** `execute` has no default timeout; an explicit positive timeout uses seconds.
18. **Resolved:** `console` is a throwing guidance proxy, child stdio is ignored, output comes only from `return`, complete output is persisted, transcript output uses middle truncation, and no `execution_read()` capability is exposed.
19. **Resolved:** transcript output is limited to 2,000 lines and 50 KiB, whichever is reached first, using a budgeted prefix + `[truncated]` + suffix; `output.yaml` remains complete.
20. **Resolved:** `output.yaml` contains the complete SuperJSON envelope encoded as deterministic, read-paginatable YAML; SuperJSON supports circular references.
21. **Resolved:** there is no extension-level concurrency limit or queue for JavaScript executions.
22. **Resolved:** default `execution_list()` returns all running entries plus only the current session's non-running count; callers must explicitly request current-session non-running entries.
23. **Resolved:** `execution_stop` uses `SIGTERM` followed by `SIGKILL` after a fixed 5-second grace period; cooperative VM cancellation is not exposed.
24. **Resolved:** every async completed, failed, timed-out, or explicitly stopped execution delivers exactly one terminal notification when the originating session remains available.
25. **Resolved:** step-one execution has no configuration file; the selected artifact, truncation, stop, timeout, and concurrency policies are fixed v1 behavior.
26. **Resolved:** failures persist full normalized phase/code/message/cause/stack/exit diagnostics, with JavaScript locations mapped to `source.js`; transcript diagnostics use normal bounded projection.
27. **Resolved:** v1 supports Linux only; macOS and Windows are explicitly unsupported until tested.
28. **Resolved:** the v1 custom TUI renderer shows only mode, execution ID, status, and duration; sync partial updates contain status/duration only.
29. **Resolved:** step one is implemented only as local workspace packages with no publication setup or public API commitment.

## Non-goals for v1

- A general terminal emulator or replacement for Herdr.
- Exposing the entire Herdr protocol as a pass-through interface.
- Interactive full-screen commands such as editors through the agent `bash` tool.
- Moving commands between workspaces based on cwd heuristics; the calling pane's Herdr workspace is authoritative.
- Silently re-executing failed Herdr commands through local bash.
- Implementing the future `pi-sub` tab, Pi subagent launch, or subagent lifecycle capabilities.
- macOS or Windows support in v1.
