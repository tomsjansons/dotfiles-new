---
name: tj-loop
description: Orchestrate the full GitHub issue loop for a `feature` or `bug` scope. Use to implement child `task` issues one by one, review, fix review issues, create stacked PRs, address PR feedback, and move to the next ready `task` issue.
---

# tj-loop

## Rules

- This is an orchestration skill. Delegate implementation, local review, and PR preparation to the focused `tj-*` skills in fresh subagent sessions.
- Start a new fresh subagent session for every `tj-impl`, `tj-review`, and `tj-pr` invocation; do not reuse a prior subagent conversation for the next phase or next issue.
- Accept an issue number or issue URL.
- Work only within the starting `feature` or `bug` scope.
- Determine scope from labels, not GitHub issue type metadata.
- If an issue has more than one of `feature`, `bug`, or `task`, stop and ask which workflow label is authoritative.
- Treat the `ready` label as technical/functional clarity only, not dependency order.
- Use blocking/blocked-by relationships separately to decide which ready issue can run next.
- Do not start `task` issues from other parent `feature` or `bug` issues.
- Use `gh` for all GitHub reads and updates.
- Do not use issue comments as workflow state.
- Communicate review state through the implementation issue `### Review` section.
- Commit after each `tj-impl` run when code changes need to be preserved in git.
- Use clear conventional commit messages with `feat:`, `fix:`, or `chore:` prefixes.
- Push only when local review passes and the branch is ready for PR, or during cycles that address PR review/check feedback.
- Never rebase workflow branches. Resolve branch updates and conflicts with fast-forward when possible, otherwise merge commits.
- Never force push or use `--force`, `--force-with-lease`, or any equivalent history-rewriting push.
- If a branch update would require rewriting published history, stop and report the blocker instead of rebasing or force pushing.

## Objective

Drive every same-scope implementation issue to the best current state without assuming prior state is still valid.

For a parent `feature` or `bug`, the loop objective is complete only when every child `task` issue in that parent scope is one of:

- not ready because it lacks the `ready` label
- waiting behind an earlier dependency-order issue
- PR-ready with current PR comments/checks/mergeability refreshed
- left in `checks-not-started` after PR checks failed to appear within 1 minute
- explicitly unable to proceed after attempting repair, with the remaining blocker reported

Conflicts, failed checks, and PR review comments are not acceptable end states by themselves. They are repair signals: run `tj-impl`, then `tj-review`, then `tj-pr` until they are resolved or the repair is explicitly unable to proceed.

For a direct `bug`, the objective is complete when that bug's implementation PR is PR-ready, left in `checks-not-started`, or explicitly unable to proceed after attempted repair.

Do not report success for a parent scope from local review alone. Existing PRs must be refreshed with `tj-pr` first because new PR comments, failed checks, closed/merged base branches, or merge conflicts may have appeared since the last run.

## State Discovery

Build current state from GitHub and git before acting:

1. Read the starting issue.
2. If the starting issue is labeled `task`, read its parent `feature` or `bug` issue.
3. If the starting issue is a small direct `bug` issue, that issue is the full scope.
4. Discover same-scope child `task` issues from parent-child relationships and blocking/blocked-by relationships.
5. Ignore issues outside the starting parent scope.
6. For each same-scope implementation issue, read labels, body, parent, `### Branch Plan`, `### Review`, `### Pull Request`, linked PR, PR comments, PR checks, PR branch, PR base branch, and mergeability/conflict state.
7. Treat `ready` as technical/functional clarity only. Use blocking/blocked-by relationships separately to decide executable order.

## Convergence Loop

Repeatedly choose the highest-priority issue state and move it forward. Use fresh subagent sessions for every delegated skill invocation.

Priority order:

1. Existing PR with merge conflict or stale stacked base
2. Existing PR with new unresolved PR review comments or failed checks
3. Existing PR whose feedback/check state has not been refreshed this run
4. Ready issue next in dependency order with no PR yet
5. Ready issue next in dependency order whose prior PR was left in `checks-not-started` and should be refreshed
6. Nothing actionable remains

For the selected issue:

1. If it has an existing PR, start a fresh subagent session running `tj-pr` first. `tj-pr` must refresh PR comments, failed checks, base branch, mergeability, and conflict state into `### Review`.
2. If the PR has a merge conflict, stale base branch, or stacked-base problem, start a fresh subagent session running `tj-impl` on the same issue and branch to reconcile the branch with its current base, resolve conflicts, and keep the change within the issue scope.
3. After any conflict or feedback fix, commit changes when local files changed.
4. Start a fresh subagent session running `tj-review` to review the repaired local diff against the current base branch.
5. If local review blocks, run fresh `tj-impl` again on the same branch, then fresh `tj-review`, until no local blocking findings remain or the repair cannot proceed.
6. Push the branch.
7. Start a fresh subagent session running `tj-pr` again to update the PR and refresh current PR comments/checks/mergeability.
8. If checks do not start within 1 minute, leave that PR in `checks-not-started` and continue to the next actionable issue.
9. If checks start, wait for terminal results unless the user asks to move on.
10. If PR comments, check failures, or merge conflicts remain, repeat this convergence cycle for the same issue before moving on, unless the PR is left in `checks-not-started` or repair is blocked.
11. If the selected issue has no PR yet, start fresh `tj-impl`, commit, fresh `tj-review`, push, then fresh `tj-pr`.
12. Continue until no same-scope issue is actionable.

## Stacked PR Base Handling

A stacked PR can become conflicted after an earlier PR is merged. The loop must actively repair this instead of treating prior local review as final.

For every issue with a PR:

- Compare `### Branch Plan` base branch, PR base branch, local branch base, and current GitHub branch state.
- If an earlier stacked PR was merged, the next PR may need its base changed to the merge target or may need the merged changes incorporated.
- If the PR reports merge conflicts, is not mergeable, or cannot update from its base, treat that as actionable work.
- Run `tj-pr` first to record the conflict/current PR state, then run `tj-impl` on the same branch to resolve the conflict.
- After resolving, run `tj-review`, push, and run `tj-pr` again.
- Do not skip a task merely because local review passed before the earlier PR was merged.

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

- `tj-impl` for code changes, branch creation, verification, and `### Results`
- `tj-review` for local review and `### Review`
- `tj-pr` for PR creation/update, PR feedback collection, failed check collection, and PR URL

## Commands

Useful patterns:

```bash
gh issue view 123 --json number,title,labels,body,parent,url
gh issue view 123 --json number,title,labels,body,parent,subIssues,url
git status --short
git branch --show-current
git add -A
git commit -m "feat: implement issue 123 task slug"
git push -u origin BRANCH
git push
```
