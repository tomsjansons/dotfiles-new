# Identify the control mechanism for an interactive spawned Pi

Type: research
Status: resolved
Blocked by:

## Question

Which supported Pi APIs, extension hooks, CLI modes, and process communication mechanisms can initialize a fresh normal-TUI Pi, submit exactly one kickoff prompt, observe completion through the relevant idle boundary, capture the final assistant result and session metadata, and cancel or shut it down—without taking terminal interactivity away from the human? Compare the feasible mechanisms against headless RPC/JSON operation, identify unsupported assumptions, and recommend the mechanism to prototype. Record the findings as a linked Markdown asset.


## Answer

Use a thin SDK bootstrap that owns one shared `AgentSession` and `InteractiveMode`, with the pane PTY reserved for the normal human TUI and an authenticated per-job Unix-domain socket for JavaScript-side control. The bootstrap must invoke and await the exact `session.prompt()` kickoff promise; that promise—not `agent_end`, terminal output, or session-file polling—is the stable completion boundary because it includes queued steering/follow-ups, retries, compaction recovery, and extension-triggered continuation.

RPC and JSON/print modes are suitable headless references but cannot retain the normal TUI. A stock-TUI control extension can inject messages, observe events, abort, and shut down, but it cannot own the kickoff promise and its `agent_end` hook can fire before retry/compaction/continuation decisions, so it is only an auxiliary shim.

The next prototype must prove TUI initialization/run-loop sequencing, startup and idle-boundary input arbitration, human steering inclusion, result capture, cancellation, retention after result, and whether `InteractiveMode` needs a small public control seam.

Research asset: [Interactive spawned-Pi control mechanisms](../research/interactive-control-mechanisms.md)