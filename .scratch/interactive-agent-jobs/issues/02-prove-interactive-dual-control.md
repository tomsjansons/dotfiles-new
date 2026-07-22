# Prove interactive dual control of a spawned Pi

Type: prototype
Status: resolved
Blocked by: 01

## Question

Can the recommended control mechanism launch a normal Pi TUI in a Herdr pane while a JavaScript-side controller reliably submits the kickoff prompt, observes the completion boundary, captures the result, permits human steering/follow-up interaction during the run, and cancels cleanly? Build the smallest throwaway end-to-end prototype, exercise the key race scenarios with the human, and link the prototype and observations from the resolution.


## Comments

Prototype prepared for the human exercise: [Interactive agent dual-control prototype](../../../.pi/agent/extensions/agent-dual-control-prototype/README.md). The shared runtime/bootstrap, authenticated Unix-socket controller, Herdr pane allocator, retained-TUI path, and cancellation path are runnable with one command.

The local headless smoke passed (`ready` → `accepted` → authoritative `result` → runtime disposal). Interactive and race findings are being recorded in [Dual-control prototype observations](../../../.pi/agent/extensions/agent-dual-control-prototype/OBSERVATIONS.md); the HITL checks remain open.

## Answer

Yes—with an explicit bootstrap protocol and a small supported `InteractiveMode` control seam. The core architecture is feasible: one SDK-owned `AgentSessionRuntime` can drive the stock normal TUI and expose the exact kickoff `session.prompt()` promise to an out-of-band controller. Pi 0.80.3 cannot do this entirely through its public `InteractiveMode` surface; the prototype required private startup-input and graceful-shutdown access.

The throwaway [interactive agent dual-control prototype](../../../.pi/agent/extensions/agent-dual-control-prototype/README.md) proved:

- a Herdr controller can allocate a dedicated `pi-shell` pane while keeping its PTY exclusively human-facing and using an authenticated mode-`0600` Unix socket for machine control;
- the bootstrap can initialize one shared runtime/TUI, accept exactly one kickoff, await that exact prompt promise, and return final assistant text, stop reason, model/usage, session pointers, and correlated run messages;
- human steering entered through the normal TUI during a 60-second kickoff appeared inside the correlated run, affected the assistant response, and delayed result delivery until the steered work reached idle;
- after result delivery, the pane remained alive and the human successfully ran an independent `POST_RESULT_OK` prompt;
- the same framing completed headlessly and then disposed the local runtime;
- timeout cancellation before bootstrap readiness exposed and fixed a late-readiness race: once cancellation owns the run, a later `ready` receives `cancel`, never `kickoff`; the bootstrap acknowledged cancellation and Herdr confirmed the pane was removed.

The specification must preserve these rules: PTY input belongs only to the human; the socket controller owns kickoff and result; the exact kickoff promise is the sole success boundary; startup-gap input must be gated or deterministically reclassified into kickoff; TUI submissions while kickoff is active are steering/follow-up work, while submissions after promise settlement belong to retained conversation; active-session replacement during kickoff is a protocol failure; and cancellation/cleanup must be idempotent in every state.

A supported implementation needs a minimal public `InteractiveMode` seam for externally-owned kickoff/input-loop sequencing, startup input gating or draining, and graceful shutdown. The prototype used private `pendingUserInputs` and `shutdown()` only to expose that requirement, not as the production design.

Detailed runs, artifacts, remaining unexercised races, and seam findings are recorded in [Dual-control prototype observations](../../../.pi/agent/extensions/agent-dual-control-prototype/OBSERVATIONS.md). Retry/compaction continuation, explicit TUI follow-up-key submission, session replacement, and controller-SIGINT races remain acceptance cases for the specification rather than blockers to feasibility.