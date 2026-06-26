---
name: tj-pr
description: Prepare, create, or refresh a GitHub PR for a `task` or small direct `bug` issue. Use after implementation results and passing local review, or to pull current PR comments/check failures back into the issue.
---

# tj-pr

## Rules

- Use `gh` for all GitHub work.
- Read and update issue descriptions. Do not use issue comments as workflow state.
- Run only for issues labeled `task` or small direct issues labeled `bug`.
- Determine PR eligibility from labels, not GitHub issue type metadata.
- If an issue has more than one of `feature`, `bug`, or `task`, stop and ask which workflow label is authoritative.
- If an issue labeled `bug` appears too large or ambiguous for direct implementation, ask the engineer whether it should get a direct PR or be split into child `task` issues. Include a recommendation.
- Accept an issue number or issue URL.
- Find any existing PR from the issue number, issue URL, `### Pull Request`, PR body closing keyword, or current branch.
- Skip merged PRs and closed issues. Do not reopen them unless explicitly asked.
- Before pushing, creating, or updating a PR, refuse if `### Results` is missing or still says implementation has not run.
- Before pushing, creating, or updating a PR, refuse if `#### Local Review` has `Verdict: blocked` or local blocking findings.
- Pull and merge the issue's base branch from `### Branch Plan`, not always `main`; never rebase.
- For stacked PRs, the Branch Plan base branch and PR base branch must match the intended current stack/base state.
- Inspect and record current PR mergeability, merge conflicts, and base-branch mismatch for existing PRs.
- If merging the base branch into the current branch conflicts, record the conflict under `#### PR Feedback`, safely abort the merge when possible, and stop. Do not hand-resolve conflicts inside `tj-pr`. `tj-loop` should call `tj-impl` to repair the branch.
- Never force push or use `--force`, `--force-with-lease`, or any equivalent history-rewriting push.
- Use fast-forward updates when possible; otherwise use merge commits.
- Create a PR when none exists.
- If a PR already exists, update it instead of creating a duplicate.
- Use `Closes #123` for issues labeled `task`.
- Use `Fixes #123` for direct issues labeled `bug`.
- Never close an issue labeled `feature` from an implementation PR.
- Update `### Pull Request` with the PR URL.
- Inspect current PR review comments and check status for existing PRs.
- Update only the `#### PR Feedback` subsection inside `### Review` with unresolved PR review comments and failed PR checks.
- Preserve the `#### Local Review` subsection unchanged.

## Flow

1. Read the issue and verify it has label `task` or `bug`.
2. Skip if the issue is closed or its existing PR is merged.
3. Read parent `feature` or `bug` issue when present.
4. Verify `### Branch Plan` exists. Missing `### Branch Plan` is a hard stop.
5. Determine current branch and intended base branch from `### Branch Plan`.
6. Find an existing PR from the issue number, issue URL, `### Pull Request`, PR body closing keyword, or current branch.
7. If a PR exists, inspect current unresolved PR review comments, current check status, base branch, and mergeability/conflict state.
8. Replace `#### PR Feedback` under `### Review` with current unresolved comments, failed checks, base mismatch, and merge conflict state.
9. Before creating or updating a PR, verify `### Results` exists and local review is not blocked.
10. Fetch the base branch and attempt to merge it into the current branch without rebasing.
11. If the merge has conflicts, record the conflict under `#### PR Feedback`, safely abort the merge when possible, and stop so implementation can resolve it.
12. Run relevant final checks.
13. Push the branch with normal `git push` only; never force push.
14. Create or update the PR with a body focused on this implementation issue and light parent context.
15. Update `### Pull Request` with the PR URL.
16. Refresh current PR comments/checks/mergeability again after create/update and update `#### PR Feedback`.

## Review Section Ownership

`### Review` has two owned subsections:

- `tj-review` owns `#### Local Review`.
- `tj-pr` owns `#### PR Feedback`.

`tj-pr` must replace only `#### PR Feedback` and preserve `#### Local Review` unchanged. If `#### PR Feedback` is missing, create it under `### Review`. If `### Review` is missing, create it with `#### PR Feedback` and do not invent local review results.

## Existing PR Feedback

When a PR already exists, inspect only current unresolved/open PR review comments. Ignore resolved and outdated threads when GitHub exposes that state.

Inspect current PR check status. For PR feedback collection:

1. If no checks are visible, wait up to 1 minute for checks to start.
2. Once checks are visible, wait for every visible check to reach a terminal result.
3. Pending, queued, waiting, in-progress, or requested checks are not exit conditions.
4. Record failed, cancelled, timed-out, or needs-attention checks.
5. If no checks start within 1 minute, record that checks did not start instead of treating the PR as clean.

Inspect current PR mergeability and base state. Record:

- PR base branch differs from `### Branch Plan` base branch or intended current stack/base state
- PR is not mergeable
- GitHub reports merge conflicts
- local merge of `origin/BASE_BRANCH` into the implementation branch conflicts

Replace `#### PR Feedback` using this shape:

```markdown
#### PR Feedback

##### PR Review Comments

- Reviewer:
  - Status: unresolved
  - Comment:
  - File/line:
  - URL:

##### PR Check Failures

- Check:
  - Status/conclusion:
  - URL:
  - Summary:

##### PR Mergeability And Base

- Base branch:
- Expected base from Branch Plan:
- Intended current stack/base state:
- Mergeable: yes | no | unknown
- Conflict state: none | GitHub reports conflicts | local base merge conflicts
- Required action: none | run `tj-impl` to resolve branch/base conflict
```

If all subsections would be empty, write a short clean state instead of preserving stale feedback:

```markdown
#### PR Feedback

No unresolved PR review comments, failed checks, base mismatch, or merge conflict are currently known.
```

## Stacked PR Base Handling

Stacked PR bases can change after earlier PRs merge. A downstream PR may originally target the previous task branch, then later need to target the merge destination, usually `main`.

For stacked PRs:

1. Compare `### Branch Plan` base branch, PR base branch, local branch state, and current GitHub branch state.
2. If the expected base branch no longer exists or has already merged, record a base mismatch under `#### PR Feedback`.
3. If the intended current stack/base state is clear from the issue body and GitHub state, update the PR base to match it.
4. If updating the base requires code conflict repair, stop after recording the required action. `tj-loop` should call `tj-impl`.
5. Never rebase or force push to repair stacked branches.

## Pull Request Body

Include:

```markdown
## Summary

## Parent Context

## Implementation Issue

Closes #123

## Changes

## Verification

## Review Status

## Risks Or Follow-Ups
```

Use `Fixes #123` instead of `Closes #123` for direct `bug` implementation.

## Commands

Useful patterns:

```bash
gh issue view 123 --json number,title,labels,body,parent,state,url
git branch --show-current
git fetch origin BASE_BRANCH
git merge origin/BASE_BRANCH -m "merge: incorporate latest BASE_BRANCH" --no-edit
git merge --abort
gh pr view --json number,title,body,url,state,mergedAt,headRefName,baseRefName,comments,reviews,statusCheckRollup
gh pr list --search "123 in:body" --json number,title,url,state,mergedAt,headRefName,baseRefName
gh pr create --base BASE_BRANCH --head CURRENT_BRANCH --title "..." --body-file pr.md
gh pr edit PR_NUMBER --title "..." --body-file pr.md
gh issue edit 123 --body-file issue.md --add-label engineering
```
