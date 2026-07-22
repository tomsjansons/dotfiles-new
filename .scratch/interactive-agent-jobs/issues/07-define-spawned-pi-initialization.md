# Define spawned Pi initialization and trust inheritance

Type: grilling
Status: resolved
Assignee: toms
Blocked by: 02, 03

## Question

Which effective host-Pi settings and resources must a fresh spawned Pi inherit, which may be overridden per `agent()` call, and how are they transferred safely in both Herdr and local modes? Cover cwd, executable/distribution, model/provider, thinking level, environment, extensions, tools, skills/prompts, credentials, project trust, session naming/storage, and behavior when inherited configuration cannot be reproduced headlessly.

## Answer

Initialize the spawned process by the rule “a fresh normal Pi launched manually from the host session's cwd,” with only four agent-specific inputs: cwd, project trust, model, and thinking level. At each `agent()` invocation, obtain these from the root host Pi session—not an intermediate or nested JavaScript job. An explicit request model or thinking level wins; each omitted value uses the root host session's current effective value.

Pass project trust as the root host's current effective trusted/untrusted decision for this run only. This keeps interactive Herdr and local headless launches aligned without another prompt; do not write the inherited decision to Pi's trust store.

Everything else follows ordinary child-process and Pi startup behavior. Resolve `pi` through `PATH`, inherit the spawning process environment normally, and let the child rediscover settings, config directories, resources, extensions, tools, skills, prompts, credentials, model availability, and session storage. Do not snapshot or reproduce the host's loaded resources, sanitize or guarantee environment state, pin or compare Pi versions, perform compatibility handshakes or model preflights, or recover specially from headless-only differences. Configuration can legitimately differ from the already-running host if files, `PATH`, environment, or discovered resources differ.

Create a fresh persisted Pi session in the child's normally selected session directory. It has no `parentSession` relationship to the host and no forced session name; managed-job lineage, artifacts, and launch metadata provide correlation. Ordinary Pi startup and model-selection failures propagate naturally to the agent-job seam, which applies the public `AgentError` contract already defined by the JavaScript interface.
