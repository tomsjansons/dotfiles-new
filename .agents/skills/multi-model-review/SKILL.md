---
name: multi-model-review
description: 'Review a change along four aspects (complexity, correctness, coverage, maintainability) by running one identical review brief through two independent subagents on different models (DeepSeek and GLM), then synthesizing: revalidate every finding, contrast agreements against disagreements, keep what survives and name what was discarded. Use when the user says "multi-model review", or wants a code review cross-checked across models. Mutations (edits, commits, PRs) are done by the main session, never the subagen'
---

One change, one brief, four aspects, two models. Neither reviewer sees the other's report. You (the main session) own the synthesis and every mutation.

- Reviewer A (`commandcode/deepseek/deepseek-v4.1-flash`)
- Reviewer B (`zai/glm-5.3-flash`)

The four aspects:

- **Complexity.** Is this the simplest change that solves the problem?
- **Correctness.** Does it solve the problem, and does it introduce new ones?
- **Coverage.** Does it address the whole problem space, or one instance of it?
- **Maintainability.** Does it fit the codebase's design, and does it leave the code easier to change next time?

## Process

### 1. Pin the review target

Whatever the user named is the target: a commit SHA, branch, tag, `HEAD~5`, or the working tree. If they named nothing, review the working tree against `HEAD`.

Capture the diff command once: `git diff <fixed-point>...HEAD` (three-dot, so the comparison runs against the merge-base), plus the commit list from `git log <fixed-point>..HEAD --oneline`. Confirm the fixed point resolves (`git rev-parse`) and the diff is non-empty. A bad ref or empty diff should fail here, not inside two subagents.

Then find the requirement the change is meant to satisfy, since correctness and coverage are judged against it. Look for issue references in the commit messages (`#123`, `Closes #45`, GitLab `!67`), a path the user passed, or a PRD/spec under `docs/`, `specs/`, or `.scratch/`. If nothing turns up, say so in the brief and have the reviewers judge intent from the code itself.

Done when you have one diff command, one commit list, a non-empty diff, and either the requirement text or an explicit "no spec available".

### 2. Rewrite the brief as read-only review

Open with `Review task (READ-ONLY, report only):`, then the four aspects with the bullets above pasted in full, the diff command, the commit list, and the requirement (or the note that none exists). The reviewers start fresh, so the brief carries everything.

Add the two instructions that make the review honest:

- **Read the real code.** Each reviewer reads every changed file in full and greps for sibling call sites. A diff alone cannot answer coverage or maintainability.
- **Evidence per finding.** Every finding carries the aspect it belongs to, a file and line, and the quoted hunk. Name the failing path for correctness, the untouched sibling for coverage.

Keep the prohibition explicit, since subagents drift:

> You must not edit, create, or delete files; create issues or PRs; commit; install anything; or otherwise change state. If the task seems to require a mutation, describe exactly what should change instead of doing it.

Demand a verdict on all four aspects, including the ones the change passes. "Complexity, nothing to flag" is a finding. Cap the report at 500 words.

Done when the brief cannot be executed mutatively and names all four aspects.

### 3. Spawn both reviewers in parallel

One message, two `Agent` tool calls, both `subagent_type: general-purpose`, both `run_in_background: false`. Your next action needs both reports. The prompts are identical. The `model` parameter is the only difference:

- Reviewer A: `model: "commandcode/deepseek/deepseek-v4.1-flash"`
- Reviewer B: `model: "zai/glm-5.3-flash"`

Same brief, both models. Splitting the four aspects between them is the tempting wrong move, since agreement and disagreement only carry signal when both answered the same question.

Wait for both. If one errors, retry it once. If it still fails, synthesize from the survivor and say plainly that only one model answered.

### 4. Synthesize

Work in this order:

1. **Restate.** The target, then each model's verdict per aspect in a line or two.
2. **Revalidate.** Reproduce the finding yourself: read the cited line, run the test, run the type check, grep for the missing sibling. A finding that does not survive is discarded, however precise it sounded. This step may run checks (tests, builds, type checks) but changes nothing tracked.
3. **Contrast.** Agreements first (consensus, spot-check anything load-bearing), then disagreements, which are where one model named something the other missed or the two verdicts contradict. Decide disagreements on the revalidate evidence, never on confidence or verbosity.
4. **Assemble.** Build the review from the findings that survived, grouped by aspect and tagged consensus or single-model. Name what was discarded and which model produced it, so the user sees what did not make the cut and why.

Done when the user has the merged findings plus the discard list.

### 5. Mutate (main session only)

Apply the accepted fixes yourself now, in the main session, then rerun the checks that cover them. For each finding the fix is the smallest edit that resolves it. Never hand a mutation to a subagent "for convenience". If the change needs no fix, this step is stating that.

## Picking this over code-review

`code-review` splits the work by axis (Standards, Spec) across two subagents and reports the axes side by side without merging. This skill runs the *same* four-aspect brief on two *different models* and merges the results. Reach for this one when you want the cross-model disagreement signal. Reach for `code-review` when the repo has documented standards and an originating spec to hold the change against.

## Why two models

Same brief, different training, different blind spots. Agreement is weak evidence, since both models can share a wrong assumption. Disagreement points at where the truth is expensive. The synthesis step is the product. Two reviewers without it just double the noise.
