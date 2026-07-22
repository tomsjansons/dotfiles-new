# Interactive spawned-Pi control mechanisms

## Scope and source baseline

This investigation targets the installed `@earendil-works/pi-coding-agent` **0.80.3** package. Citations use this alias:

```text
PI_ROOT=/home/toms/.local/share/pnpm/store/v11/links/@earendil-works/pi-coding-agent/0.80.3/bf6664b5d2b0d3bcf48282cbe54501810f725d505110e4a8bb85427ff7ab4c48/node_modules/@earendil-works/pi-coding-agent
```

The relevant domain terms are:

- **Kickoff run**: the complete work causally owned by one accepted kickoff prompt, including tool turns, steering and follow-up messages queued before it reaches idle, retries, and automatic continuation after compaction.
- **Stable completion**: the point at which the promise for that kickoff run resolves. It is stronger than observing an individual `agent_end` event.
- **Dual control**: a programmatic owner and the human-facing TUI act on the same `AgentSession` without proxying or taking over the TUI's terminal streams.

## Decision

Prototype a **thin SDK bootstrap around one shared `AgentSession` and `InteractiveMode`**, controlled over a per-job authenticated Unix-domain socket. The bootstrap, not an extension event handler and not terminal scraping, should own the kickoff call and await its exact `session.prompt()` promise.

In Herdr, run that bootstrap with its stdin/stdout attached directly to the pane's PTY so `InteractiveMode` remains a normal Pi TUI. The JavaScript-side controller uses only the out-of-band socket. Outside Herdr, reuse the same bootstrap/control contract without `InteractiveMode`, then dispose the local runtime after the kickoff completes.

This is a recommendation to prototype, not yet proof that the TUI startup/input races are acceptable. The next ticket must prove the sequencing and identify whether a small Pi control seam is needed.

## Why this mechanism is the best fit

### `AgentSession.prompt()` is the authoritative completion primitive

The SDK documents `AgentSession.prompt()` as “send a prompt and wait for completion,” exposes direct state, session id/file, queueing, abort, and disposal, and exposes `agent.waitForIdle()` where lower-level waiting is needed (`PI_ROOT/docs/sdk.md:70-115`, `PI_ROOT/docs/sdk.md:184-238`, `PI_ROOT/docs/sdk.md:240-264`). It also states that an accepted `prompt()` resolves only after the full run, including retries (`PI_ROOT/docs/sdk.md:198-204`).

The implementation is stronger evidence than any event heuristic: `prompt()` awaits `_runAgentPrompt()`, which awaits `agent.prompt()` and then repeatedly continues while post-run handling reports retry, compaction recovery, or messages queued by `agent_end` handlers (`PI_ROOT/dist/core/agent-session.js:685-720`, `PI_ROOT/dist/core/agent-session.js:731-853`). That promise therefore marks the stable boundary required by `agent()`.

Once it resolves, the bootstrap can inspect `session.messages`, `session.model`, `session.thinkingLevel`, `session.sessionId`, and `session.sessionFile`; the public type exposes these directly (`PI_ROOT/dist/core/agent-session.d.ts:261-303`). Assistant messages already contain provider/model, usage, stop reason, error text, and timestamp (`PI_ROOT/docs/rpc.md:1306-1331`).

### `InteractiveMode` and `AgentSession` are designed to share the same runtime

Pi documents and exports `InteractiveMode` as the full TUI layered over an `AgentSessionRuntime` (`PI_ROOT/docs/sdk.md:958-1000`). Its `run()` initializes the TUI, processes an initial prompt by awaiting the same `session.prompt()`, and then enters the normal human input loop (`PI_ROOT/dist/modes/interactive/interactive-mode.js:540-609`). During streaming, TUI submissions are sent through `session.prompt(..., { streamingBehavior: "steer" })`, so they join the active run instead of starting a competing session (`PI_ROOT/dist/modes/interactive/interactive-mode.js:2168-2208`).

`InteractiveMode.init()` is public and idempotent; it starts the terminal UI, installs editor handlers, binds extensions, and subscribes/render resources before returning (`PI_ROOT/dist/modes/interactive/interactive-mode.d.ts:101-117`, `PI_ROOT/dist/modes/interactive/interactive-mode.js:421-526`). This makes a thin bootstrap feasible, although the exact order of `init()`, starting the normal input loop, and invoking the kickoff must be proven.

### An out-of-band socket preserves terminal ownership

Pi chooses interactive mode only when both stdin and stdout are TTYs; otherwise it falls back to print mode unless RPC/JSON was explicitly selected (`PI_ROOT/dist/main.js:78-88`). Therefore stdin/stdout cannot simultaneously be a reliable machine protocol and the human's normal TUI streams.

A per-job Unix-domain socket avoids that conflict and works even when the Herdr shell, rather than the JavaScript job process, is the immediate parent of Pi. The socket protocol is project-owned glue, not a built-in Pi protocol. It should use JSONL or length framing, a random endpoint and nonce, restrictive filesystem permissions, explicit request ids, and messages such as `ready`, `kickoff`, `accepted`, `result`, `cancel`, `shutdown`, and `protocol_error`.

## Capability matrix

| Mechanism | Normal TUI retained | Programmatic kickoff | Authoritative stable completion | Result/session metadata | Cancel/shutdown | Verdict |
|---|---:|---:|---:|---:|---:|---|
| SDK `AgentSession` + `InteractiveMode` in a thin bootstrap | Yes | Yes, direct `prompt()` | **Yes, by awaiting that exact promise** | Direct state and events | `session.abort()`; runtime/process cleanup | **Prototype this** |
| Stock interactive CLI with an initial positional prompt | Yes | Yes, at launch | No completion promise reaches the owner | Needs extension/session-file observation | Signals or extension hook | Useful fallback/fixture, not sufficient alone |
| Stock TUI plus a control extension | Yes | `pi.sendUserMessage()` | No: extension `agent_end` is too early in some paths | Mostly available from event/context | `ctx.abort()` / `ctx.shutdown()` | Auxiliary bridge only; not completion authority |
| RPC mode | No normal TUI | Yes | Can watch events/state; prompt response is acceptance only | Yes | RPC `abort`, process termination | Correct headless subprocess protocol, wrong Herdr UX |
| JSON/print mode | No | Initial prompt only | Process/prompt completion | JSON events or final text | Signal/process termination | Suitable local one-shot reference, not interactive |
| PTY scraping or session-file polling | Superficially | Keystroke/argv injection | No supported correlation or idle boundary | Partial/brittle | Signals | Reject |

## Why the alternatives are insufficient

### RPC is deliberately headless

RPC is a JSONL protocol over stdin/stdout for headless embedding (`PI_ROOT/docs/rpc.md:1-37`). A `prompt` response means only accepted, queued, or handled; later failures arrive through the event stream (`PI_ROOT/docs/rpc.md:41-78`). It provides prompt, steer/follow-up, abort, state, messages, and `agent_end` events (`PI_ROOT/docs/rpc.md:80-135`, `PI_ROOT/docs/rpc.md:160-213`, `PI_ROOT/docs/rpc.md:802-844`), but its stdin/stdout are the machine protocol, not the built-in TUI. RPC “extension UI” forwards selected dialog requests to an external client; it does not instantiate the normal Pi TUI (`PI_ROOT/docs/rpc.md:1047-1237`).

RPC remains the closest reference protocol for the local headless path, but a second normal TUI cannot safely attach to the same RPC-owned session.

### JSON/print modes intentionally exit

JSON mode emits the session header and all session events, including `agent_end`, as JSONL (`PI_ROOT/docs/json.md:1-82`). Print mode awaits each prompt, emits final text or events, disposes the runtime, and exits (`PI_ROOT/dist/modes/print-mode.js:14-130`). Both are good acceptance-test or local-fallback references, but neither permits retained human interaction.

### A control extension exposes useful hooks but not the exact promise

Extensions can:

- distinguish TUI/RPC/JSON/print mode and inspect read-only session state (`PI_ROOT/docs/extensions.md:900-950`);
- inject a real user message with `pi.sendUserMessage()` and choose steer/follow-up delivery while streaming (`PI_ROOT/docs/extensions.md:1376-1402`);
- observe `agent_start`, `agent_end`, message, turn, and input events (`PI_ROOT/docs/extensions.md:509-580`, `PI_ROOT/docs/extensions.md:849-898`);
- inspect idle/pending state, abort, and request graceful shutdown, which TUI defers until queued work is idle (`PI_ROOT/docs/extensions.md:956-1001`);
- clean up a socket in `session_shutdown` (`PI_ROOT/docs/extensions.md:497-507`).

Those hooks make an extension useful for telemetry, a prototype shim, or a stock-CLI fallback. They are not sufficient as the final completion authority:

1. `pi.sendUserMessage()` is typed as `void`; its implementation starts the async session call and converts rejection into an extension error, so the extension does not receive the kickoff promise (`PI_ROOT/dist/core/extensions/types.d.ts:873-884`, `PI_ROOT/dist/core/agent-session.js:1768-1785`).
2. Extension `agent_end` carries messages but not the session-level `willRetry` flag (`PI_ROOT/dist/core/extensions/types.d.ts:516-524`). The implementation emits extension `agent_end` before public session listeners and before post-run retry/compaction/continuation logic (`PI_ROOT/dist/core/agent-session.js:271-331`, `PI_ROOT/dist/core/agent-session.js:380-388`, `PI_ROOT/dist/core/agent-session.js:685-720`). Settling there can therefore report too early.
3. Extension events have no kickoff correlation id. Human input, extension-injected input, and later independent prompts must be arbitrated by custom state.
4. `ctx.waitForIdle()` exists only on command contexts, while ordinary event contexts expose only instantaneous `isIdle()` and pending checks (`PI_ROOT/dist/core/extensions/types.d.ts:208-250`).

### Terminal or session-file observation is not a control protocol

The TUI owns terminal rendering, input modes, escape sequences, and human keystrokes. Scraping it conflates presentation with state. Session persistence is append-oriented and useful as an artifact pointer, but polling it cannot distinguish temporary idle, retry/compaction continuation, or a second human prompt with the required causal precision. Neither approach is documented as a supported controller interface.

## Proposed prototype shape

The next ticket should build only enough to validate these claims:

1. **Controller**: create a private temporary directory, bind an authenticated Unix socket, and launch a bootstrap in a real Herdr PTY.
2. **Bootstrap**: construct one `AgentSessionRuntime` using the documented SDK factory/services and one `InteractiveMode` over that same runtime (`PI_ROOT/docs/sdk.md:120-182`, `PI_ROOT/docs/sdk.md:962-1000`).
3. **Readiness**: initialize the TUI and report `ready` with session id/file only after extension/resource binding and terminal startup complete.
4. **Kickoff ownership**: accept exactly one `kickoff` request; invoke `session.prompt()` exactly once; retain that exact promise as the completion token.
5. **Human steering**: while the promise is pending, type steering and follow-up input in the pane and prove it is included before the promise resolves.
6. **Result**: after resolution, select the final assistant message from the run, validate its stop reason, and return text plus compact model/usage/session metadata. Do not infer success from prose.
7. **Retention**: leave `InteractiveMode` and its human input loop alive after returning the result.
8. **Cancellation**: on `cancel`, call `session.abort()` and wait for idle; also prove SIGTERM restores the terminal and disposes the runtime. `AgentSession.abort()` aborts and waits for idle (`PI_ROOT/dist/core/agent-session.js:1097-1104`); interactive SIGTERM/SIGHUP performs runtime disposal and terminal restoration (`PI_ROOT/dist/modes/interactive/interactive-mode.js:2689-2729`, `PI_ROOT/dist/modes/interactive/interactive-mode.js:2779-2793`).
9. **Local control**: run the same kickoff/result framing without `InteractiveMode`, then dispose the runtime, to prove the protocol is not Herdr-specific.

## Races and unsupported assumptions the prototype must answer

- **Startup input race**: `InteractiveMode.init()` starts editor handling before the bootstrap's direct kickoff necessarily reaches `agent_start`. Human input in that interval can be queued as an independent idle prompt. Prove an ordering/gate that prevents duplicate or competing kickoff work.
- **Run-loop coexistence**: prove that the normal `InteractiveMode.run()` input loop can remain active while the bootstrap awaits its separately-owned `session.prompt()` promise without concurrent idle prompts corrupting ownership.
- **Boundary race**: define whether a human submit concurrent with stable kickoff completion belongs to the kickoff run or to the retained post-result conversation, and make the classification deterministic.
- **Retry and compaction**: force auto-retry and automatic continuation after compaction; prove the direct prompt promise outlives intermediate `agent_end` events.
- **Extension continuation**: load an extension that queues work from `agent_end`; prove the promise includes it.
- **Cancellation race**: cancel during model streaming, tool execution, queued steering, retry delay, and immediately after completion; prove one terminal result and idempotent cleanup.
- **Session replacement**: first-version scope says no programmatic resume/fork/reconnect, but a human can invoke built-in session commands. Decide whether the bootstrap rejects replacement during the kickoff, follows `runtime.session`, or treats it as cancellation/protocol failure.
- **Public seam gap**: `InteractiveMode` exposes `init()` and `run()` but not a public “run input loop around this externally-owned prompt” method or public graceful shutdown method (`PI_ROOT/dist/modes/interactive/interactive-mode.d.ts:101-117`, `PI_ROOT/dist/modes/interactive/interactive-mode.d.ts:261-288`). The prototype may use a throwaway shim, but the specification must not pretend this seam already exists if proof requires a Pi change.
- **Configuration parity**: SDK construction supports the needed resources and settings, but reproducing the host Pi's *effective* CLI/runtime state is not automatic. That belongs to the spawned-Pi initialization ticket, not this decision.

## Recommendation boundary

The supported pieces exist, but **Pi 0.80.3 does not expose a ready-made external dual-control protocol for a stock running TUI**. The recommended route is therefore:

- use Pi's documented SDK and full `InteractiveMode` rather than emulate either one;
- keep one shared `AgentSession` as the deep module and completion authority;
- keep PTY I/O exclusively human-facing;
- add the smallest possible private socket/bootstrap seam for owner control;
- treat any need to alter `InteractiveMode` sequencing as an explicit implementation seam discovered by the prototype, not as an extension trick or event heuristic.
