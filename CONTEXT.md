# Pi Managed Agents

Vocabulary for managed jobs that launch fresh Pi sessions from isolated JavaScript jobs.

## Language

**Agent request**:
The complete one-shot instruction and launch preferences for a fresh spawned Pi session. It is distinct from the resulting managed job and spawned session.
_Avoid_: Agent input, agent options


**Kickoff prompt**:
The required non-empty text instruction that begins an agent request's single programmatically owned run.
_Avoid_: Initial message, task prompt

**Host session**:
The Pi session that owns the JavaScript job lineage in which an agent request is made. Intermediate managed jobs are not configuration parents.
_Avoid_: Parent job, parent agent

**Model selector**:
An atomic provider-scoped model identity comprising a provider name and model ID. Omitting it means using the host session's selected model.
_Avoid_: Provider-model pair, model override

**Agent result**:
The minimal value returned after an agent request reaches stable completion. Detailed run evidence remains in the spawned session and managed-job artifacts rather than being duplicated in the result.
_Avoid_: Job result, agent response