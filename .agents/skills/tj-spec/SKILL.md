---
name: tj-spec
description: Spec GitHub Feature, Bug, or Task issues. Use when a poorly described Feature or Bug needs research, interview, scoping, child Task creation, parent-child links, blocking order, or when a Task/small Bug needs an implementation-ready spec.
---

# tj-spec

## Rules

- Use `gh` for all GitHub work.
- Read and update issue descriptions. Do not use issue comments as workflow state.
- If the user gives an issue number, assume the current repository.
- Handle only issue types `Feature`, `Bug`, and `Task`.
- Do not change priority, owner, assignee, milestone, or unrelated project fields unless asked.
- Ask up to five focused questions per turn.
- For every question, include your recommended answer so the engineer can accept, reject, or correct it quickly.
- Keep the issue body resumable after every interaction: remove answered questions and integrate the answers into the spec.
- Created implementation Tasks start with type `Task`, label `engineering`, and `Implementation readiness: blocked`.
- Created Task titles must use `[Task] {order} {title}`.
- Every Task and implementation-ready direct Bug must include `### Branch Plan`.
- Set `Implementation readiness: ready` only when the issue is specific enough to implement.

## Issue Modes

### Feature

Feature issues are parent scope only. Do not implement them directly.

1. Read the Feature issue body.
2. Research the current code, product behavior, integration points, and tests before asking questions.
3. Interview the engineer about behavior, design, sequencing, review boundaries, and delivery risks.
4. Propose an ordered Task breakdown with final titles, branch names, base branches, and blocking relationships.
5. Wait for engineer confirmation.
6. Create or update child Task issues.
7. Link every Task to the parent Feature.
8. Link Tasks in implementation order with blocking/blocked-by relationships.
9. Update the parent issue with a `### Created Tasks` section.
10. Leave task-specific open questions in the relevant child Task bodies.

### Bug

1. Read the Bug issue body.
2. Research current behavior, affected code, reproduction path, tests, logs, APIs, and data flow.
3. Decide whether it is a small direct Bug or a large Bug.
4. For a small direct Bug, update the Bug body using the implementation issue structure and keep type `Bug`.
5. For a large Bug, split it into child Tasks using the Feature flow and keep the parent type `Bug`.

### Task

1. Read the Task issue body.
2. Read the parent Feature or Bug when present.
3. Research relevant code, patterns, contracts, data flow, and tests.
4. Interview the engineer about implementation details, dependencies, edge cases, verification, and branch stacking.
5. Update the Task body until it is implementation-ready.
6. Fill `### Branch Plan`.
7. Set `Implementation readiness: ready` only when no blocking questions remain.

## Research Checklist

Before asking engineering questions or proposing Tasks, identify:

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

Use this structure for Tasks and small direct Bugs:

```markdown
### Parent Context

### Engineering Questions

List only unresolved questions. Remove answered questions and integrate the answers below.

### Implementation Spec

Implementation readiness: blocked

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

_Review has not run._

### Pull Request

_PR has not been created._
```

## Branch Plan

Use stable, short, lowercase branch names.

```markdown
### Branch Plan

- Suggested branch: feature-PARENT-task-ISSUE-slug
- Base branch: main
- Stacking notes: Not stacked.
```

For stacked Tasks, set each Task base branch to the previous Task branch when it depends on earlier unmerged work.

For direct Bugs, prefer:

```text
fix-ISSUE-slug
```

## GitHub Relationship Mechanics

Use `gh` only. Prefer native `gh issue` flags when available in the installed CLI. If the local `gh` version does not expose parent/sub-issue or dependency flags, use `gh api` or `gh api graphql`.

Required relationships for split work:

- parent Feature or Bug has every implementation Task as a child issue
- Task 1 blocks Task 2, Task 2 blocks Task 3, and so on when delivery is sequential
- independent Tasks are children of the parent but do not need blocking links

After relationship updates, verify with `gh issue view` or `gh api` that the parent-child and blocking links exist. If GitHub permissions or API support prevent relationship updates, stop and report exactly which links were not created.

## Commands

Useful patterns:

```bash
gh repo view --json nameWithOwner
gh issue view 123 --json number,title,body,issueType,parent,url
gh issue create --title "[Task] 1 Title" --body-file task.md --type Task --label engineering
gh issue edit 123 --body-file issue.md --add-label engineering
```
