# Specify interactive agent jobs for JavaScript

Label: wayfinder:map

## Destination

An implementation-ready specification for `agent()`: a JS-job-only asynchronous primitive that launches a fresh Pi instance, supports true parallel calls, provides an interactive Herdr pane when available and a local headless fallback otherwise, and returns a defined result after the kickoff run reaches idle. The specification includes architecture, lifecycle, configuration, errors, implementation sequence, and acceptance tests, but not the implementation itself.

## Notes

- Domain: Pi managed jobs, isolated JavaScript jobs, Herdr workspaces, and spawned Pi sessions.
- Consult `/domain-modeling` throughout; use `/research` for Pi control-surface investigation, `/prototype` for dual-control feasibility, and `/codebase-design` for module boundaries and lifecycle seams.
- Planning only: implementation and production code changes are outside this map.
- `agent()` is the provisional API. Each call launches one fresh Pi session and returns a plain `Promise<AgentResult>`; future additive APIs such as `agent.start()` may expose a conversation handle.
- The underlying representation must initially be a new `agent` job type. Launching, listing, and stopping agent jobs are available only inside managed JavaScript jobs; normal model-facing job tools must not expose agent capabilities or records. Keep that visibility policy reversible.
- `agent()` is available in root and nested JavaScript jobs. Calls run independently without a new concurrency limit and can be composed with `Promise.all`.
- In Herdr, each spawned Pi gets an independent interactive pane in `pi-shell`; create the tab when absent. Outside Herdr, use a local headless process with the same completion contract.
- Completion means Pi is idle after the kickoff prompt and any steering/follow-up messages queued during that run. Human interaction through the pane is allowed. On success, retain the Herdr Pi/pane for the human but shut down the local headless Pi.
- While pending, owning-job stop or timeout cancels and cleans up the spawned Pi. `agent()` has no per-call timeout; callers control the whole operation through the owning JavaScript job's timeout or stop lifecycle.
- Keep the public result lean: final assistant `output`, successful `stopReason`, spawned session id/path, and the managed-job `artifactDir`. Pi session and job artifacts remain authoritative for model, usage, interaction, launch, timing, and diagnostics. Reject failures with one structural `AgentError` and stable category codes; do not duplicate Pi internals.
- Spawned Pi inherits the root host session's current cwd, model, thinking level, and effective project trust; per-call model/thinking overrides win. Everything else uses ordinary fresh-Pi discovery and child-process behavior, including `PATH`, environment, resources, credentials, tools, and session storage.
- Initial scope is Linux only and one-shot JS prompting only.

## Decisions so far

- [Identify the control mechanism for an interactive spawned Pi](issues/01-identify-interactive-pi-control-mechanism.md) — Prototype one SDK-owned `AgentSession`/`InteractiveMode` bootstrap with PTY-only human I/O, authenticated Unix-socket control, and the exact kickoff `prompt()` promise as completion authority.
- [Prove interactive dual control of a spawned Pi](issues/02-prove-interactive-dual-control.md) — One shared SDK runtime can support authoritative programmatic kickoff plus a retained human TUI, but production needs explicit startup arbitration and public `InteractiveMode` control seams.
- [Define the provisional `agent()` JavaScript contract](issues/03-define-agent-js-contract.md) — Use a strict text-first request with optional Pi-native model/thinking selection, exact `prompt()` completion, a lean output/session/artifact result, parent-owned timeout, and one coded error family.
- [Define spawned Pi initialization and trust inheritance](issues/07-define-spawned-pi-initialization.md) — Inherit only root-host cwd, trust, and resolved model/thinking; otherwise launch a fresh independent `pi` from `PATH` using normal discovery and process behavior.

## Not yet specified


## Out of scope

- Implementing the feature or changing production code; this effort ends at the approved implementation-ready specification.
- Exposing `agent()`, the `agent` job type, or agent-job records to the normal model-facing tool context in the first version.
- Resuming, forking, reconnecting to, or programmatically continuing an existing spawned session.
- A first-version JS conversation handle for subsequent messages; preserve an additive path such as `agent.start()` for later work.
- Non-Linux support.
