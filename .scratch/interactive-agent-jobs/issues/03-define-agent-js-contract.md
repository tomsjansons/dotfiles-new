# Define the provisional `agent()` JavaScript contract

Type: grilling
Status: resolved
Blocked by: 02

## Question

What exact serializable input, `AgentResult`, typed error taxonomy, timeout behavior, completion semantics, and compatibility seams should the first `agent()` API expose? Resolve how final assistant content, usage/model metadata, session and artifact pointers, launch-mode/pane metadata, and human interaction during the kickoff run appear in the result while preserving a future additive `agent.start()` handle API.


## Answer

The first version exposes one global asynchronous function inside managed JavaScript jobs:

```ts
declare function agent(request: AgentRequest): Promise<AgentResult>;

type AgentRequest = Readonly<{
  prompt: string;
  model?: Readonly<Pick<Model, "provider" | "id">>;
  thinkingLevel?: ThinkingLevel;
}>;

type AgentResult = Readonly<{
  output: string;
  stopReason: "stop" | "length";
  session: {
    id: string;
    path: string;
  };
  artifactDir: string;
}>;
```

### Request and compatibility

`agent()` accepts one strict plain serializable object. `prompt` is required text with at least one non-whitespace character; validation preserves the original text. `model.provider` and `model.id` are required together as one atomic selector when `model` is present. Unknown request/model fields, non-plain values, and invalid structural values reject before job allocation with `ERR_AGENT_INPUT`. The request is copied at invocation so later mutation has no effect.

The agent layer must consume Pi's public `Model`, `ThinkingLevel`, `ModelRegistry`, and model-capability machinery rather than copy their vocabularies or resolution logic. Pi resolves the model selector. Omitted model and thinking level inherit from the host Pi session that owns the JavaScript job lineage, not from an intermediate managed job. A thinking level known to Pi but unsupported by the selected model uses Pi's normal clamping; a value unknown to the installed Pi version is a configuration failure. There is no v1 `cwd`, image, timeout, environment, resource, tool, credential, launch-mode, or session option.

A future additive `agent.start(request)` may return a handle whose `result` is `Promise<AgentResult>`. V1 reserves no handle fields or placeholder operations; `agent(request)` can remain the convenience equivalent of awaiting that future result.

### Completion and output

Each call immediately allocates one independent hidden `agent` job and launches one fresh Pi session. Calls compose directly with `Promise.all` and add no concurrency limit. Success is governed only by the exact accepted `AgentSession.prompt()` promise: it includes the kickoff prompt, TUI steering and follow-up messages classified into that run, retries, compaction recovery, and extension-triggered continuation until stable idle. Human model and thinking-level changes remain available through the normal TUI.

Use Pi's public session state and accessors. In particular, obtain final text from `session.getLastAssistantText()` rather than reimplementing assistant-content extraction, and obtain session identity from `session.sessionId` and `session.sessionFile`. A final assistant stop reason of `stop` or `length` resolves; `length` deliberately exposes possibly partial output for the caller to judge. Provider error, abort, a final `toolUse`, prompt rejection, or absence of a final text result rejects. `agent()` reports run completion, never semantic task success.

There is no per-call timeout. Owning JavaScript job timeout or stop owns the whole operation and cascades cancellation and cleanup to pending agent jobs.

### Lean metadata boundary

The public result contains only output, successful stop reason, session id/path, and the managed-job artifact directory. It does not duplicate usage, model metadata, provider-reported model, human-interaction counts, timing, launch/pane metadata, job id, configuration snapshots, or a second immutable transcript. Pi's session file remains authoritative for messages, model history, per-turn usage, and human input; ordinary managed-job artifacts remain authoritative for job identity, launch resources, timing, protocol/process diagnostics, and terminal state.

### Errors

All failures reject with one safely reconstructed structural error; callers branch on `code`, not `instanceof`:

```ts
interface AgentError extends Error {
  name: "AgentError";
  code:
    | "ERR_AGENT_INPUT"
    | "ERR_AGENT_CONFIGURATION"
    | "ERR_AGENT_LAUNCH"
    | "ERR_AGENT_RUN"
    | "ERR_AGENT_CANCELLED"
    | "ERR_AGENT_INTERNAL";
  artifactDir?: string;
  cause?: unknown; // safely serializable
}
```

`INPUT` covers request shape; `CONFIGURATION` covers unavailable models, unrecognized thinking levels, and unreproducible required host configuration; `LAUNCH` covers routing, allocation, spawn, and readiness; `RUN` covers accepted-prompt/final-assistant failures; `CANCELLED` covers owning-job stop, timeout, abort, and host shutdown; `INTERNAL` covers protocol, unexpected process/control-channel termination, and required persistence failures. Preserve detailed Pi/provider/process errors as a serializable `cause` and in artifacts rather than inventing parallel error hierarchies. Errors created after allocation include `artifactDir`.