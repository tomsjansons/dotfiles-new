---
name: tj-impl
description: Implement a specced GitHub Task or small direct Bug issue. Use only when the issue body says exactly `Implementation readiness: ready`, including review-feedback fix cycles on the existing implementation branch.
---

# tj-impl

## Rules

- Use `gh` for GitHub issue reads and updates.
- Read and update issue descriptions. Do not use issue comments as workflow state.
- Implement only `Task` issues or small direct `Bug` issues.
- Refuse to start unless the issue body contains exactly `Implementation readiness: ready`.
- Read the parent Feature or Bug when present.
- Do not change project status.
- Do not update `### Review`.
- For new implementation work, create or switch to the suggested branch from `### Branch Plan`.
- For review-feedback work, stay on the existing implementation branch.
- Refuse to create or switch branches when there are uncommitted changes.
- Branch from the base branch named in `### Branch Plan`.
- Update `### Results` before finishing.

## Flow

1. Read the implementation issue with `gh issue view`.
2. Verify issue type is `Task` or `Bug`.
3. Verify readiness line is exactly `Implementation readiness: ready`.
4. Read parent Feature or Bug context when present.
5. Read `### Branch Plan` and determine suggested branch, base branch, and stacking notes.
6. Decide whether this run starts new implementation work or addresses review feedback.
7. If starting new work, ensure the current branch is the suggested branch, creating it from the correct base when needed.
8. If addressing review feedback, keep the current branch and refuse automatic branch switching.
9. Inspect the codebase and create an implementation todo list.
10. Implement the smallest complete code change for this issue.
11. Run focused verification, formatting, and relevant tests.
12. Update `### Results` with current truth.
13. Report what changed and what remains for review.

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
4. Create the suggested branch from `origin/BASE_BRANCH` when it does not exist.
5. Switch to the suggested branch when it exists locally.
6. Verify the current branch matches the intended implementation branch before editing code.

For review-feedback work, do not create a new branch. Stay on the existing implementation branch.

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
gh issue view 123 --json number,title,issueType,body,parent,url
git status --short
git branch --show-current
git fetch origin BASE_BRANCH
git switch SUGGESTED_BRANCH
git switch -c SUGGESTED_BRANCH origin/BASE_BRANCH
gh issue edit 123 --body-file issue.md
```
