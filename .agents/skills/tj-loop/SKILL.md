---
name: tj-loop
description: Orchestrate the full GitHub issue loop for a `feature` or `bug` scope. Use to implement child `task` issues one by one, review, fix review issues, create stacked PRs, address PR feedback, and move to the next ready `task` issue.
---

# tj-loop

## Rules

- This is an orchestration skill. Delegate implementation, local review, and PR preparation to the focused `tj-*` skills.
- Accept an issue number or issue URL.
- Work only within the starting `feature` or `bug` scope.
- Determine scope from labels, not GitHub issue type metadata.
- If an issue has more than one of `feature`, `bug`, or `task`, stop and ask which workflow label is authoritative.
- Do not start `task` issues from other parent `feature` or `bug` issues.
- Use `gh` for all GitHub reads and updates.
- Do not use issue comments as workflow state.
- Communicate review state through the implementation issue `### Review` section.
- Commit after each `tj-impl` run when code changes need to be preserved in git.
- Use clear conventional commit messages with `feat:`, `fix:`, or `chore:` prefixes.
- Push only when local review passes and the branch is ready for PR, or during cycles that address PR review/check feedback.

## Scope Discovery

1. Read the starting issue.
2. If the starting issue is labeled `task`, read its parent `feature` or `bug` issue.
3. If the starting issue is a small direct `bug` issue, that `bug` issue is the full scope.
4. Discover sibling `task` issues only from:
   - parent `feature` or `bug` issue child issues
   - blocking and blocked-by relationships inside that same parent scope
5. Ignore ready `task` issues that belong to other parent `feature` or `bug` issues.
6. Select the next `task` issue only when it has the `ready` label.

## Main Loop

For each selected `task` issue or direct `bug` issue:

1. Run `tj-impl` with the issue number or URL.
2. Inspect `git status --short`.
3. Commit the implementation with a clear conventional commit message.
4. Run `tj-review` with the same issue number or URL.
5. Read the issue `### Review` section.
6. If local review has blocking findings, run `tj-impl` again on the same issue and branch.
7. Repeat implementation, commit, and local review until `### Review` has no blocking findings.
8. Push the branch.
9. Run `tj-pr` with the same issue number or URL.
10. Inspect the PR result and current PR check status.
11. If no check runs are visible, wait up to 1 minute for them to start.
12. If no checks start within 1 minute, stop this issue's PR loop and report that checks did not start.
13. Once checks have started, wait for every PR check to reach a terminal result.
14. Pending, queued, waiting, in-progress, or requested checks are not exit conditions.
15. If any PR check fails, is cancelled, times out, needs attention, or if open PR review comments exist, run `tj-pr` once to append current PR problems under `### Review`.
16. Run `tj-impl` again on the same issue and branch to fix PR feedback.
17. Commit and push each PR-feedback implementation cycle.
18. Run `tj-review` locally again before refreshing the PR.
19. Repeat local review, push, `tj-pr`, check waiting, and PR feedback handling until the issue is PR-ready.

## PR Feedback Gate

Treat the issue as blocked when `### Review` includes any of:

- local `Verdict: blocked`
- local blocking findings
- open PR review comments appended by `tj-pr`
- failed PR checks appended by `tj-pr`

Treat the issue as ready when:

- local review has no blocking findings
- no open PR review comments are present
- all PR checks have started and reached terminal results
- no failed, cancelled, timed-out, or needs-attention PR checks are present

Pending, queued, waiting, in-progress, or requested PR checks do not count as ready or blocked. Wait until terminal results are known. If no checks start within 1 minute, stop and report the missing check start.

## Next `task` Issue Selection

After the current `task` issue or direct `bug` issue reaches the ready state:

1. If the starting issue was a direct `bug` issue, end.
2. Read the parent `feature` or `bug` issue child `task` issues.
3. Follow blocking and blocked-by relationships to preserve delivery order.
4. Select the next `task` issue in the same parent scope that has the `ready` label.
5. Start a new branch for the next `task` issue through `tj-impl`; do not reuse the previous branch unless the next `task` issue's `### Branch Plan` names it as the current branch.
6. If no same-scope ready `task` issue remains, end.

## Commit Guidance

Use the issue title and work type to choose the prefix:

```text
feat: implement issue 123 task slug
fix: address issue 123 review feedback
chore: update issue 123 verification notes
```

Prefer one commit after each completed `tj-impl` run. If the implementation run only updated the GitHub issue body and no local files changed, do not create an empty commit.

## Delegated Skills

Use these focused skills instead of duplicating their behavior:

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
