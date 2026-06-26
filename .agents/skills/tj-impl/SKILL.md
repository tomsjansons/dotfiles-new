---
name: tj-impl
description: "Implement a specced GitHub `task` or small direct `bug` issue. Use only when the issue has the `ready` label, including review-feedback fix cycles on the existing implementation branch."
---

# tj-impl

## Rules

- Use `gh` for GitHub issue reads and updates.
- Read and update issue descriptions. Do not use issue comments as workflow state.
- Implement only issues labeled `task` or small direct issues labeled `bug`.
- Determine eligibility from labels, not GitHub issue type metadata.
- If an issue has more than one of `feature`, `bug`, or `task`, stop and ask which workflow label is authoritative.
- If an issue labeled `bug` appears too large or ambiguous for direct implementation, ask the engineer whether it should be implemented directly or split into child `task` issues. Include a recommendation.
- Refuse to start unless the issue has the `ready` label.
- Read the parent issue labeled `feature` or `bug` when present.
- Do not change project status.
- Do not update `### Review`.
- For new implementation work, create or switch to the suggested branch from `### Branch Plan`.
- For review-feedback or PR-conflict repair work, stay on the existing implementation branch.
- Refuse to create or switch branches when there are uncommitted changes.
- Branch from the base branch named in `### Branch Plan`.
- Never rebase implementation branches. Use fast-forward when possible, otherwise merge commits.
- Never force push or use `--force`, `--force-with-lease`, or any equivalent history-rewriting push.
- If resolving conflicts or incorporating a base branch, merge the base into the implementation branch and commit the merge.
- Update `### Results` before finishing.

## Flow

1. Read the implementation issue with `gh issue view`.
2. Verify the issue has label `task` or `bug`.
3. Verify the issue has the `ready` label.
4. Read parent `feature` or `bug` context when present.
5. Verify `### Branch Plan` exists. Missing `### Branch Plan` is a hard stop.
6. Read suggested branch, base branch, and stacking notes from `### Branch Plan`.
7. Decide whether this run starts new implementation work, addresses local review feedback, addresses PR feedback/check failures, or repairs a branch/base conflict recorded by `tj-pr`.
8. If starting new work, ensure the current branch is the suggested branch, creating it from the correct base when needed.
9. If addressing feedback or conflict repair, keep the current branch and refuse automatic branch switching.
10. Inspect the codebase and create an implementation todo list.
11. Implement the smallest complete code change for this issue.
12. Run focused verification, formatting, and relevant tests.
13. Update `### Results` with current truth.
14. Report what changed and what remains for review.

## Branch Handling

Use `### Branch Plan` as the source of truth:

```markdown
### Branch Plan

- Suggested branch:
- Base branch:
- Stacking notes:
```

For new implementation work:

1. Run `git status --short`.
2. Refuse branch changes if there are uncommitted changes.
3. Fetch the base branch from origin.
4. If the base branch does not exist locally or on origin, stop and report that the Branch Plan is stale or invalid.
5. Create the suggested branch from `origin/BASE_BRANCH` when it does not exist.
6. Switch to the suggested branch when it exists locally.
7. Verify the current branch matches the intended implementation branch before editing code.

For review-feedback, PR-feedback, or conflict-repair work, do not create a new branch. Stay on the existing implementation branch.

For conflict repair or base updates:

1. Fetch the current base branch.
2. Fast-forward when possible.
3. If fast-forward is not possible, merge `origin/BASE_BRANCH` into the implementation branch with a merge commit.
4. Resolve conflicts in that merge commit.
5. Do not rebase, reset published history, or force push.
6. If normal push is rejected because histories diverged, fetch and merge again.

## Issue Body Contract

Implementation expects these sections to exist:

- `### Branch Plan`
- `### Results`
- `### Review`
- `### Pull Request`

Missing `### Branch Plan` is a hard stop. If `### Results` is missing but the issue is otherwise clearly specced, create it when writing results. Do not modify `### Review` or `### Pull Request`.

## Results Section

Replace the previous Results section with current truth:

```markdown
### Results

- Implementation summary:
- Files changed:
- Checks run:
- Manual verification:
- UI evidence:
- Deviations or limitations:
```

For non-UI tasks, write `UI evidence: Not applicable`.

## Commands

Useful patterns:

```bash
gh issue view 123 --json number,title,labels,body,parent,url
git status --short
git branch --show-current
git fetch origin BASE_BRANCH
git switch SUGGESTED_BRANCH
git switch -c SUGGESTED_BRANCH origin/BASE_BRANCH
git merge origin/BASE_BRANCH --no-edit
gh issue edit 123 --body-file issue.md
```
