---
name: multi-model-review
description: 'Review a change along focus points (cohesion, correctness, edge cases, complexity trajectory, maintainability) by running one identical review brief through three independent subagents on different models (DeepSeek, GLM, MiMo), then synthesizing: revalidate every finding, contrast agreements against disagreements, keep what survives and name what was discarded. Writes two dark-themed HTML reports — {task-id}-review.html and {task-id}-diagram.html — to ~/dev/show-me, following the show-me skill. Use when the user says "multi-model review", or wants a code review cross-checked across models. Mutations (edits, commits, PRs) are done by the main session, never the subagents'
---

One change, one brief, a focus list, three models. Neither reviewer sees the others' reports. You (the main session) own the synthesis, the HTML reports, and every mutation.

- Reviewer A (`commandcode/deepseek/deepseek-v4.1-flash`)
- Reviewer B (`commandcode/z-ai/glm-5.3-flash`)
- Reviewer C (`commandcode/xiaomi/mimo-v2.6-flash`)

The default focus points. If the user supplies their own list, theirs replaces these wholesale — whatever the list, it goes into the brief verbatim and all three reviewers answer the same one:

- **Cohesion.** Does the solution fit the current system — its sessions, components, and established patterns?
- **Correctness.** Does it correctly implement the requirements?
- **Edge cases.** Does it address the whole problem space or one instance of it, and are boundary cases handled — or explicitly acknowledged with caveats?
- **Complexity trajectory.** Is complexity trending up or down? Is the goal reached with the simplest possible setup?
- **Maintainability.** Are there no unnecessary type gymnastics, abstractions, or plumbing?

## Process

### 1. Pin the review target and the task id

Whatever the user named is the target: a commit SHA, branch, tag, `HEAD~5`, a PR or PR stack (base..tip), or the working tree. If they named nothing, review the working tree against `HEAD`.

Capture the diff command once: `git diff <fixed-point>...HEAD` (three-dot, so the comparison runs against the merge-base), plus the commit list from `git log <fixed-point>..HEAD --oneline`. Confirm the fixed point resolves (`git rev-parse`) and the diff is non-empty. A bad ref or empty diff should fail here, not inside three subagents.

Then find the requirement the change is meant to satisfy, since correctness and edge cases are judged against it. Look for issue references in the commit messages (`#123`, `Closes #45`, GitLab `!67`), a path the user passed, or a PRD/spec under `docs/`, `specs/`, or `.scratch/`. If nothing turns up, say so in the brief and have the reviewers judge intent from the code itself.

Also derive the task id the reports are named after: the ticket the user named (like `adv-244`), the branch name, or a hyphenated slug of the change — lowercase and filename-safe.

Done when you have one diff command, one commit list, a non-empty diff, one task id, and either the requirement text or an explicit "no spec available".

### 2. Rewrite the brief as read-only review

Open with `Review task (READ-ONLY, report only):`, then the focus points with the bullets pasted in full (the user's list if they gave one, the defaults otherwise), the diff command, the commit list, and the requirement (or the note that none exists). The reviewers start fresh, so the brief carries everything.

Add the two instructions that make the review honest:

- **Read the real code.** Each reviewer reads every changed file in full and greps for sibling call sites. A diff alone cannot answer cohesion or edge cases.
- **Evidence per finding.** Every finding carries the focus point it belongs to, a file and line, and the quoted hunk. Name the failing path for correctness, the untouched sibling for edge cases.

Keep the prohibition explicit, since subagents drift:

> You must not edit, create, or delete files; create issues or PRs; commit; install anything; or otherwise change state. If the task seems to require a mutation, describe exactly what should change instead of doing it.

Demand a verdict on every focus point, including the ones the change passes. "Cohesion, nothing to flag" is a finding. Cap the report at 500 words.

Done when the brief cannot be executed mutatively and names every focus point.

### 3. Spawn all three reviewers in parallel

One message, three `Agent` tool calls, all `subagent_type: general-purpose`, all `run_in_background: false`. Your next action needs all three reports. The prompts are identical. The `model` parameter is the only difference:

- Reviewer A: `model: "commandcode/deepseek/deepseek-v4.1-flash"`
- Reviewer B: `model: "commandcode/z-ai/glm-5.3-flash"`
- Reviewer C: `model: "commandcode/xiaomi/mimo-v2.6-flash"`

Same brief, all three models. Splitting the focus points between them is the tempting wrong move, since agreement and disagreement only carry signal when all answered the same question.

Wait for all three. If one errors, retry it once. If it still fails, synthesize from the survivors and say plainly which models did not answer.

### 4. Synthesize

Work in this order:

1. **Restate.** The target, then each model's verdict per focus point in a line or two.
2. **Revalidate.** Reproduce the finding yourself: read the cited line, run the test, run the type check, grep for the missing sibling. A finding that does not survive is discarded, however precise it sounded. This step may run checks (tests, builds, type checks) but changes nothing tracked.
3. **Contrast.** Agreements first (consensus, spot-check anything load-bearing), then disagreements, which are where one model named something the other missed or the verdicts contradict. Decide disagreements on the revalidate evidence, never on confidence or verbosity.
4. **Assemble.** Build the review from the findings that survived, grouped by focus point and tagged consensus, two-of-three, or single-model. Name what was discarded and which model produced it, so the user sees what did not make the cut and why.

Done when the user has the merged findings plus the discard list.

### 5. Write the visual reports (main session only)

Everything in the reports comes from what survived step 4 — nothing gets a pretty picture that failed revalidation.

Write two dark-themed HTML files in `~/dev/show-me/`, following the show-me skill for the artifact itself (read it first if it isn't already in context): one focused file, the smallest view that makes the point clear, real labels and code from this change (no lorem, no placeholder diagrams), legible on desktop and mobile. Skip either file the user said they didn't want.

- **`{task-id}-review.html`** — the review as a visual report: one section per focus point; every finding tagged consensus / two-of-three / single-model with file and line; the quoted hunk or a small before → after code example illustrating each problem; compact diagrams (Mermaid or inline SVG) where a schema beats prose; the discard list at the end, with which model produced each discarded finding.
- **`{task-id}-diagram.html`** — how the change sits in the system: data flow through the touched components, including the shapes that flow between them; trigger and decision logic as a flow or sequence; and what the change shares between parts (prompts, machinery, types) plus who owns each side. If the user asked for specific diagrams, those lead and these three are the defaults.

Both files are dark themed: dark background, light text, `color-scheme: dark`, code and diagram styling that reads on dark.

If the user asked only for diagrams — no review — skip steps 2–4: still pin the target and read the real code, then write only `{task-id}-diagram.html`.

### 6. Mutate (main session only)

Apply the accepted fixes yourself now, in the main session, then rerun the checks that cover them. For each finding the fix is the smallest edit that resolves it. Never hand a mutation to a subagent "for convenience". If the change needs no fix, this step is stating that.

## Why three models

Same brief, different training, different blind spots. Agreement is weak evidence, since all three models can share a wrong assumption; a two-against-one split is a majority, not a verdict — the revalidate step still decides. Disagreement points at where the truth is expensive. The synthesis step is the product. Three reviewers without it just triple the noise.
