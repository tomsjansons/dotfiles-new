---
name: multi-model
description: Run one research brief through two independent subagents on different models (DeepSeek and GLM), wait for both, then synthesize — revalidate claims, contrast disagreements, keep the correct parts, discard the wrong ones. Use when the user says "multi-model", "ask both models", or wants a second opinion cross-checked across models. Mutations (files, issues, commits) are done by the main session, never the subagents.
---

Two independent researchers, one brief, two models. Neither sees the other's answer; you (the main session) own the synthesis and every mutation.

- Researcher A — `commandcode/deepseek/deepseek-v4.1-flash`
- Researcher B — `zai/glm-5.3-flash`

## Process

### 1. Pin the question

What does the user actually want to know or decide? If the request bundles a mutation ("fix the failing test", "open an issue for X"), split it: the *question* goes to the subagents, the *mutation* stays here for step 5. If the question itself is ambiguous, ask before spawning two agents at it.

Done when you can state the question in one sentence.

### 2. Rewrite the brief as read-only research

Rephrase the user's prompt so it can only produce information:

- Convert mutating imperatives into diagnosis + proposal: "fix X" → "identify the root cause of X and specify the exact change (file, location, before → after) without applying it."
- Open with `Research task (READ-ONLY — report only):`, then the rephrased brief plus any context it needs (paths, error text, constraints) — the subagents start fresh.
- Keep the prohibition explicit; subagents drift:

  > You must not edit, create, or delete files; create issues or PRs; commit; install anything; or otherwise change state. If the task seems to require a mutation, describe exactly what should change instead of doing it.

- Demand evidence: every claim carries a file path, command output, or source.
- Give a word cap (400 is a good default) — long reports are harder to synthesize than to trust.

Done when the brief cannot be executed mutatively.

### 3. Spawn both researchers in parallel

One message, two `Agent` tool calls, both `subagent_type: general-purpose`, both `run_in_background: false` — your next action needs both results. The prompts are identical; the `model` parameter is the only difference:

- Researcher A: `model: "commandcode/deepseek/deepseek-v4.1-flash"`
- Researcher B: `model: "zai/glm-5.3-flash"`

Wait for both. If one errors, retry it once; if it still fails, synthesize from the survivor and say plainly that only one model answered.

### 4. Synthesize

Work in this order:

1. **Restate** — the question, then each model's answer in a line or two.
2. **Revalidate** — check the load-bearing claims yourself against ground truth: read the files they cite, rerun the commands, grep for the symbols. A precise-sounding citation is not a verified one. This is the main session's job and may include running checks (tests, builds, type checks) — but nothing that changes tracked state.
3. **Contrast** — agreements first (consensus; spot-check anything load-bearing), then disagreements. Decide disagreements on the evidence from revalidate, never on confidence or verbosity.
4. **Assemble** the final answer from the parts that survived. Then name what was discarded — the wrong or unsupported parts and which model produced them — so the user sees what didn't make the cut and why.

Done when the user has the synthesized answer plus the discard list.

### 5. Mutate (main session only)

If the original request implied changes — edits, issues, PRs, commits — do them yourself now, from the synthesized result, in the main session. Never hand a mutation to a subagent "for convenience". If no mutation is needed, this step is stating that.

## Why two models

Same brief, different training → different blind spots. Agreement is weak evidence (both can share a wrong assumption); disagreement is a pointer to where the truth is expensive. The synthesis step is the product — two researchers without it just double the noise.
