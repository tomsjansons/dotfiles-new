---
name: tj-loop
description: Orchestrate the full GitHub issue loop for a `feature` or `bug` scope. Use to implement child `task` issues one by one, review, fix review issues, create stacked PRs, address PR feedback, and move to the next ready `task` issue.
---

# tj-loop

## Rules

- This is an orchestration skill. Delegate implementation, local review, and PR preparation to the focused `tj-*` skills in fresh subagent sessions.
- Start a new fresh subagent session for every `tj-impl`, `tj-review`, and `tj-pr` invocation; do not reuse a prior subagent conversation for the next phase or next issue.
- Delegated skills must be self-sufficient from the issue number or issue URL. Do not rely on long custom prompts for correctness.
- Accept an issue number or issue URL.
- Work only within the starting `feature` or `bug` scope.
- Determine scope from labels, not GitHub issue type metadata.
- If an issue has more than one of `feature`, `bug`, or `task`, stop and ask which workflow label is authoritative.
- If a `bug` issue appears too large or ambiguous for direct implementation, ask the engineer whether it should be implemented directly or split into child `task` issues. Include a recommendation.
- Treat the `ready` label as technical/functional clarity only, not dependency order.
- Use blocking/blocked-by relationships separately to decide which ready issue can run next.
- Do not start `task` issues from other parent `feature` or `bug` issues.
- Skip merged PRs and closed issues. Pick the next issue in dependency order.
- Use `gh` for all GitHub reads and updates.
- Do not use issue comments as workflow state.
- Communicate local review state through `### Review` → `#### Local Review`.
- Communicate PR comments, checks, mergeability, and base state through `### Review` → `#### PR Feedback`.
- Commit after each `tj-impl` run when code changes need to be preserved in git.
- Use clear conventional commit messages with `feat:`, `fix:`, or `chore:` prefixes.
- Push only when local review passes and the branch is ready for PR, or during cycles that address PR review/check feedback.
- Never rebase workflow branches. Resolve branch updates and conflicts with fast-forward when possible, otherwise merge commits.
- Never force push or use `--force`, `--force-with-lease`, or any equivalent history-rewriting push.
- If a branch update would require rewriting published history, stop and report the blocker instead of rebasing or force pushing.

## Objective

Drive every same-scope implementation issue to the best current state without assuming prior state is still valid.

For a parent `feature` or `bug`, the loop objective is complete only when every child `task` issue in that parent scope is one of:

- closed
- backed by a merged PR
- not ready because it lacks the `ready` label
- waiting behind an earlier dependency-order issue
- PR-ready with current PR comments/checks/mergeability refreshed
- left in `checks-not-started` after PR checks failed to appear within 1 minute
- explicitly unable to proceed after attempting repair, with the remaining blocker reported

Conflicts, failed checks, and PR review comments are not acceptable end states by themselves. They are repair signals: run `tj-impl`, then `tj-review`, then `tj-pr` until they are resolved or the repair is explicitly unable to proceed.

For a direct `bug`, the objective is complete when that bug's implementation PR is merged, PR-ready, left in `checks-not-started`, closed, or explicitly unable to proceed after attempted repair.

Do not report success for a parent scope from local review alone. Existing PRs must be refreshed with `tj-pr` after local review is clean because new PR comments, failed checks, closed/merged base branches, or merge conflicts may have appeared since the last run.

## State Discovery

Build current state from GitHub and git before acting:

1. Read the starting issue.
2. If the starting issue is labeled `task`, read its parent `feature` or `bug` issue.
3. If the starting issue is a small direct `bug` issue, that issue is the full scope.
4. Discover same-scope child `task` issues from parent-child relationships and blocking/blocked-by relationships.
5. Ignore issues outside the starting parent scope.
6. For each same-scope implementation issue, read labels, state, body, parent, `### Branch Plan`, `#### Local Review`, `#### PR Feedback`, `### Pull Request`, linked PR, PR state, PR comments, PR checks, PR branch, PR base branch, and mergeability/conflict state.
7. Skip closed issues and issues whose linked PR is already merged.
8. Treat `ready` as technical/functional clarity only. Use blocking/blocked-by relationships separately to decide executable order.
9. If `### Branch Plan` is missing for an otherwise actionable issue, mark it `unable-to-proceed` and report that the issue must return to `tj-spec`.

## Action States

Use these canonical states when deciding and reporting work:

- `closed`: issue is closed; skip it.
- `merged`: linked PR is merged; skip it.
- `not-ready`: issue lacks the `ready` label.
- `dependency-blocked`: issue is ready but waits behind an earlier dependency-order issue.
- `needs-implementation`: issue is ready, dependency-unblocked, and has no PR yet.
- `local-review-blocked`: `#### Local Review` has `Verdict: blocked` or open local blocking findings.
- `pr-feedback-blocked`: refreshed PR state has unresolved PR review comments.
- `pr-check-blocked`: refreshed PR state has failed, cancelled, timed-out, or needs-attention checks.
- `merge-conflict-blocked`: refreshed PR or local base merge state has conflicts or non-mergeability.
- `stack-base-blocked`: stacked PR base does not match the intended current stack/base state.
- `checks-not-started`: no PR checks became visible within 1 minute.
- `pr-ready`: local review passes, current PR feedback is clean, checks are terminal and successful, mergeability is clean, and base branch is correct.
- `unable-to-proceed`: repair was attempted but cannot proceed safely.

## Convergence Loop

Repeatedly choose the highest-priority issue state and move it forward. Use fresh subagent sessions for every delegated skill invocation.

Priority order:

1. Existing PR whose local review is blocked or whose branch has known uncommitted repair work pending
2. Existing PR with merge conflict, non-mergeable state, or stale stacked base
3. Existing PR with new unresolved PR review comments or failed checks
4. Existing PR whose feedback/check state has not been refreshed this run and whose local review is clean
5. Ready issue next in dependency order with no PR yet
6. Ready issue next in dependency order whose prior PR was left in `checks-not-started` and should be refreshed
7. Nothing actionable remains

For the selected issue with an existing PR:

1. Read `#### Local Review` first.
2. If local review is blocked, start a fresh subagent session running `tj-impl` on the same issue and branch to fix the local blocking findings.
3. Commit changes when local files changed.
4. Start a fresh subagent session running `tj-review`; it must refuse uncommitted changes and use local review state to review only commits since `Last reviewed commit` when valid.
5. If local review still blocks, repeat `tj-impl` and `tj-review` until no local blocking findings remain or the repair cannot proceed.
6. Only after local review is clean, start a fresh subagent session running `tj-pr` to refresh PR comments, failed checks, base branch, mergeability, and conflict state into `#### PR Feedback`.
7. If `tj-pr` records a merge conflict, stale stacked base, or branch/base problem, start a fresh subagent session running `tj-impl` on the same issue and branch to reconcile the branch with its current base, resolve conflicts, and keep the change within the issue scope.
8. After any conflict or PR feedback fix, commit changes when local files changed.
9. Run fresh `tj-review` again.
10. If local review passes, push the branch.
11. Run fresh `tj-pr` again to update the PR and refresh current PR comments/checks/mergeability.
12. If checks do not start within 1 minute, leave that PR in `checks-not-started` and continue to the next actionable issue.
13. If checks start, wait for terminal results unless the user asks to move on.
14. If PR comments, check failures, merge conflicts, or stacked-base problems remain, repeat this convergence cycle for the same issue before moving on, unless the PR is left in `checks-not-started` or repair is blocked.

For the selected issue with no PR yet:

1. Start a fresh subagent session running `tj-impl`.
2. Commit local changes when local files changed.
3. Start a fresh subagent session running `tj-review`.
4. If local review blocks, run fresh `tj-impl` to fix, commit, then run fresh incremental `tj-review`; repeat until local review passes or repair is blocked.
5. Push the branch.
6. Start a fresh subagent session running `tj-pr`.
7. If `tj-pr` records PR comments, failed checks, merge conflicts, or stacked-base problems, continue through the existing-PR cycle for that same issue.

Continue until no same-scope issue is actionable.

## Stacked PR Base Handling

A stacked PR can become conflicted or stale after an earlier PR is merged. The loop must actively repair this instead of treating prior local review as final.

Stacked merges can start from either end of the stack:

- If earlier PRs merge first, downstream PRs may need their base branch advanced from the previous task branch to the merge destination, usually `main`.
- If later PRs remain stacked on an unmerged previous task branch, their base should stay on that previous task branch.
- If a middle PR merges or closes, every downstream task must be re-evaluated against the actual GitHub branch and PR state before work continues.

For every issue with a PR:

- Compare `### Branch Plan` base branch, PR base branch, local branch base, current GitHub branch state, and whether earlier stacked PRs are merged or closed.
- If an earlier stacked PR was merged, decide whether the next PR should now target the merge destination or remain stacked on another unmerged branch.
- If the intended current base differs from `### Branch Plan`, update `### Branch Plan` and the PR base branch to match when the correct base is clear from GitHub state.
- If the correct base is not clear, stop and ask the engineer.
- If the PR reports merge conflicts, is not mergeable, or cannot update from its base, treat that as actionable work.
- Run `tj-pr` only after local review is clean to record the current PR state, then run `tj-impl` on the same branch to resolve any conflict or base repair.
- After resolving, run `tj-review`, push, and run `tj-pr` again.
- Do not skip a task merely because local review passed before an earlier PR was merged.

## Branch Safety

All branch manipulation must preserve published history.

- Do not run `git rebase`, interactive rebase, reset-to-rewrite, cherry-pick ranges as a rebase substitute, or history-editing commands on workflow branches.
- Update branches by fast-forwarding when possible.
- If fast-forward is not possible, merge the current base branch into the implementation branch with a merge commit.
- Resolve conflicts in the merge commit, then continue with local review, push, and PR refresh.
- Push with normal `git push` only.
- Never use force push, `--force-with-lease`, or any equivalent option.
- If Git rejects a normal push because histories diverged, fetch and merge; do not rebase and do not force push.
- If the situation cannot be repaired without rewriting history, stop and report the blocker.

## PR Feedback Gate

Treat an issue as blocked when current refreshed state includes any of:

- local `Verdict: blocked`
- local blocking findings
- unresolved PR review comments
- failed, cancelled, timed-out, or needs-attention PR checks
- merge conflict or non-mergeable PR state
- branch/base mismatch for a stacked PR

Treat an issue as PR-ready when current refreshed state has:

- local review with no blocking findings
- no unresolved PR review comments
- all visible PR checks started and reached terminal results
- no failed, cancelled, timed-out, or needs-attention PR checks
- no merge conflict
- PR base branch matches the intended current stack/base state

Pending, queued, waiting, in-progress, or requested PR checks do not count as PR-ready or blocked. Wait until terminal results are known once checks have started.

If no PR checks start within 1 minute, treat that PR as `checks-not-started`: leave it alone, do not treat it as failed or clean, and continue to the next actionable same-scope issue.

## Parent Scope Status

When the loop finishes or pauses, update or report a parent-scope status summary when useful:

```markdown
### Implementation Status

- Task #1: merged | pr-ready | checks-not-started | blocked | not-ready | dependency-blocked | closed
- Task #2: ...
```

Do not mark the parent scope successful while actionable blocked PR feedback, failed checks, merge conflicts, or stale stacked bases remain.

## Commit Guidance

Use the issue title and work type to choose the prefix:

```text
feat: implement issue 123 task slug
fix: address issue 123 review feedback
chore: update issue 123 verification notes
```

Prefer one commit after each completed `tj-impl` run. If the implementation run only updated the GitHub issue body and no local files changed, do not create an empty commit.

## Delegated Skills

Use these focused skills in fresh subagent sessions instead of duplicating their behavior:

- `tj-impl` for code changes, branch creation, branch/base conflict repair, verification, and `### Results`
- `tj-review` for incremental local review, finding resolution tracking, and `#### Local Review` state
- `tj-pr` for PR creation/update, PR feedback collection, failed check collection, mergeability/base state, and PR URL

Delegation can be as simple as invoking the skill with the issue number or URL. The delegated skill must read the issue body, branch plan, repository state, and GitHub state to decide what to do.

## Commands

Useful patterns:

```bash
gh issue view 123 --json number,title,labels,state,body,parent,url
gh issue view 123 --json number,title,labels,state,body,parent,subIssues,url
git status --short
git branch --show-current
git add -A
git commit -m "feat: implement issue 123 task slug"
git push -u origin BRANCH
git push
```
