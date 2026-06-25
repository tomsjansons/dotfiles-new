---
name: tj-pr
description: Prepare, create, or refresh a GitHub PR for a Task or small direct Bug. Use after implementation results and passing local review, or to pull current PR comments/check failures back into the issue.
---

# tj-pr

## Rules

- Use `gh` for all GitHub work.
- Read and update issue descriptions. Do not use issue comments as workflow state.
- Run only for `Task` issues or small direct `Bug` issues.
- Accept an issue number or issue URL.
- Find any existing PR from the issue number, issue URL, `### Pull Request`, PR body closing keyword, or current branch.
- Refuse if `### Results` is missing or still says implementation has not run.
- Refuse if `### Review` has local `Verdict: blocked` or local blocking findings.
- Pull and merge the issue's base branch from `### Branch Plan`, not always `main`.
- For stacked PRs, the Branch Plan base branch and PR base branch must match.
- Create a PR when none exists.
- If a PR already exists, update it instead of creating a duplicate.
- Use `Closes #123` for Task issues.
- Use `Fixes #123` for direct Bug issues.
- Never close a Feature issue from an implementation PR.
- Update `### Pull Request` with the PR URL.
- Inspect current PR review comments and check status for existing PRs.
- Update `### Review` with unresolved PR review comments and failed PR checks.

## Flow

1. Read the issue and verify type is `Task` or `Bug`.
2. Read parent Feature or Bug when present.
3. Verify Results and local Review gates.
4. Determine current branch and intended base branch from `### Branch Plan`.
5. Find an existing PR from the issue number, issue URL, `### Pull Request`, PR body closing keyword, or current branch.
6. If a PR exists, inspect current unresolved PR review comments and current check status.
7. Replace the active PR feedback subsection under `### Review` with current unresolved comments and failed checks.
8. Fetch the base branch and merge it into the current branch.
9. Resolve conflicts if needed.
10. Run relevant final checks.
11. Push the branch.
12. Create or update the PR with a body focused on this implementation issue and light parent context.
13. Update `### Pull Request` with the PR URL.

## Existing PR Feedback

When a PR already exists, inspect only current unresolved/open PR review comments. Ignore resolved and outdated threads when GitHub exposes that state.

Inspect current PR check status. For PR feedback collection:

1. If no checks are visible, wait up to 1 minute for checks to start.
2. Once checks are visible, wait for every visible check to reach a terminal result.
3. Pending, queued, waiting, in-progress, or requested checks are not exit conditions.
4. Record failed, cancelled, timed-out, or needs-attention checks.
5. If no checks start within 1 minute, record that checks did not start instead of treating the PR as clean.

Replace the active PR feedback subsection under `### Review` using this shape:

```markdown
#### PR Review Comments

- Reviewer:
  - Status: unresolved
  - Comment:
  - File/line:
  - URL:

#### PR Check Failures

- Check:
  - Status/conclusion:
  - URL:
  - Summary:
```

If both sections would be empty, remove the active PR feedback subsection or leave it absent. Do not preserve stale resolved PR review comments in the active feedback section.

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

Use `Fixes #123` instead of `Closes #123` for direct Bug implementation.

## Commands

Useful patterns:

```bash
gh issue view 123 --json number,title,issueType,body,parent,url
git branch --show-current
git fetch origin BASE_BRANCH
git merge origin/BASE_BRANCH -m "merge: incorporate latest BASE_BRANCH" --no-edit
gh pr view --json number,title,body,url,headRefName,baseRefName,comments,reviews,statusCheckRollup
gh pr list --search "123 in:body" --json number,title,url,headRefName,baseRefName
gh pr create --base BASE_BRANCH --head CURRENT_BRANCH --title "..." --body-file pr.md
gh pr edit PR_NUMBER --title "..." --body-file pr.md
gh issue edit 123 --body-file issue.md --add-label engineering
```
