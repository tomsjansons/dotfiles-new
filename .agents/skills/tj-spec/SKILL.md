---
name: tj-spec
description: Spec GitHub issues labeled `feature`, `bug`, or `task`. Use when a poorly described `feature` or `bug` issue needs research, interview, scoping, child `task` issue creation, parent-child links, blocking order, or when a `task`/small `bug` issue needs an implementation-ready spec.
---

# tj-spec

## Rules

- Use `gh` for all GitHub work.
- Read and update issue descriptions. Do not use issue comments as workflow state.
- If the user gives an issue number, assume the current repository.
- Handle only issues labeled `feature`, `bug`, or `task`.
- Determine issue mode from labels, not GitHub issue type metadata.
- If an issue has more than one of `feature`, `bug`, or `task`, stop and ask which workflow label is authoritative.
- Do not change priority, owner, assignee, milestone, or unrelated project fields unless asked.
- Ask up to five focused questions per turn.
- For every question, include your recommended answer so the engineer can accept, reject, or correct it quickly.
- Keep the issue body resumable after every interaction: remove answered questions and integrate the answers into the spec.
- Created implementation issues start with labels `task` and `engineering`, without the `ready` label.
- Created `task` issue titles must use `[Task] {order} {title}`.
- Every `task` issue and implementation-ready direct `bug` issue must include `### Branch Plan`.
- The `ready` label means the issue is technically and functionally clear enough to implement; it does not mean dependency order allows immediate work.
- Add the `ready` label when all functional and technical aspects are clear and no open engineering questions remain.
- Remove the `ready` label whenever unresolved engineering questions remain.

## Issue Modes

### `feature` label

Issues labeled `feature` are parent scope only. Do not implement them directly.

1. Read the `feature` issue body.
2. Research the current code, product behavior, integration points, and tests before asking questions.
3. Interview the engineer about behavior, design, sequencing, review boundaries, and delivery risks.
4. Propose an ordered `task` issue breakdown with final titles, branch names, base branches, and blocking relationships.
5. Wait for engineer confirmation.
6. Create or update child issues labeled `task`.
7. Link every child `task` issue to the parent `feature` issue.
8. Link `task` issues in implementation order with blocking/blocked-by relationships.
9. Update the parent issue with a `### Created Tasks` section.
10. Leave task-specific open questions in the relevant child `task` issue bodies.

### `bug` label

1. Read the `bug` issue body.
2. Research current behavior, affected code, reproduction path, tests, logs, APIs, and data flow.
3. Decide whether it appears to be a small direct `bug` issue or a large `bug` issue.
4. If the distinction is unclear, ask the engineer whether to implement the bug directly or split it into child `task` issues. Include a recommendation.
5. For a small direct `bug` issue, update its body using the implementation issue structure and keep the `bug` label.
6. For a large `bug` issue, split it into child issues labeled `task` using the `feature` flow and keep the parent labeled `bug`.

### `task` label

1. Read the `task` issue body.
2. Read the parent `feature` or `bug` issue when present.
3. Research relevant code, patterns, contracts, data flow, and tests.
4. Interview the engineer about implementation details, dependencies, edge cases, verification, and branch stacking.
5. Update the `task` issue body until all functional and technical aspects are clear.
6. Fill `### Branch Plan`.
7. Add the `ready` label only when no open engineering questions remain; do not withhold it merely because earlier dependency `task` issues must run first.

## Research Checklist

Before asking engineering questions or proposing `task` issues, identify:

- existing behavior
- relevant files and patterns
- integration points
- technical constraints
- adjacent features or workflows
- validation, permissions, error handling, loading states, and empty states
- tests and verification patterns
- likely review boundaries
- possible task split
- open decisions

Fold important findings into the issue body. Do not create separate research documents.

## Interview Style

Ask precise questions grounded in the current codebase. Cover:

- PR scope and reviewable boundaries
- edge cases and data states
- interactions with existing workflows
- technical dependencies and generated artifacts
- whether the work should be split further
- compatibility with existing users and data
- verification strategy
- stacked branch dependencies and base branches

Do not stop after one question round if important decisions remain unresolved.

## Implementation Issue Body

Use this structure for `task` issues and small direct `bug` issues:

```markdown
### Parent Context

### Engineering Questions

List only unresolved questions. Remove answered questions and integrate the answers below.

### Implementation Spec

### Implementation Plan

### Branch Plan

- Suggested branch:
- Base branch:
- Stacking notes:

### Acceptance Criteria

### Verification

### Results

_Implementation has not run._

### Review

#### Local Review

_Review has not run._

#### PR Feedback

_PR feedback has not been refreshed._

### Pull Request

_PR has not been created._
```

## Issue Body Contract

Implementation skills expect these sections to exist:

- `### Parent Context`
- `### Engineering Questions`
- `### Implementation Spec`
- `### Implementation Plan`
- `### Branch Plan`
- `### Acceptance Criteria`
- `### Verification`
- `### Results`
- `### Review`
- `### Pull Request`

`### Branch Plan` is required before implementation, review, or PR work. Missing `### Branch Plan` is a hard stop.

## Branch Plan

Use stable, short, lowercase branch names.

```markdown
### Branch Plan

- Suggested branch: feature-PARENT-task-ISSUE-slug
- Base branch: main
- Stacking notes: Not stacked.
```

For stacked `task` issues, set each `task` issue base branch to the previous `task` branch when it depends on earlier unmerged work.

When earlier stacked PRs merge, downstream task base branches may need to advance from a previous task branch to the merge target, usually `main`. Record enough stacking notes for `tj-loop` and `tj-pr` to identify the intended current base.

For direct `bug` issues, prefer:

```text
fix-ISSUE-slug
```

## GitHub Relationship Mechanics

Use `gh` only. Prefer native `gh issue` flags when available in the installed CLI. If the local `gh` version does not expose parent/sub-issue or dependency flags, use `gh api` or `gh api graphql`.

Required relationships for split work:

- parent `feature` or `bug` issue has every implementation issue labeled `task` as a child issue
- `task` issue 1 blocks `task` issue 2, `task` issue 2 blocks `task` issue 3, and so on when delivery is sequential
- independent `task` issues are children of the parent but do not need blocking links

After relationship updates, verify with `gh issue view` or `gh api` that the parent-child and blocking links exist. If GitHub permissions or API support prevent relationship updates, stop and report exactly which links were not created.

## Commands

Useful patterns:

```bash
gh repo view --json nameWithOwner
gh issue view 123 --json number,title,body,labels,parent,url
gh issue create --title "[Task] 1 Title" --body-file task.md --label task --label engineering
gh issue edit 123 --body-file issue.md --add-label ready --add-label engineering
gh issue edit 123 --body-file issue.md --remove-label ready
```
