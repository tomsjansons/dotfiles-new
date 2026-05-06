# VENT

Feedback log. Repeated/systemic workflow friction that should become future automation, docs, or workflow fixes.

## 26-05-06 00:00 — validation_tooling

Type-checking standalone extensions is avoidably manual: there is no root tsconfig, pnpm has no top-level @mariozechner package symlinks, and direct tsc either prints help or cannot resolve pi modules. I worked around it by creating a temporary tsconfig with explicit typeRoots and paths. A shared extension tsconfig or package script would make validation one command.
## 26-05-06 12:42 — tooling_validation

Repeated git diff attempts failed because hashline-tools/extensions is not inside a Git worktree, so git treated the command as --no-index and rejected multiple pathspecs. I worked around it with direct reads/rg/LSP. A quick preflight like `git rev-parse --is-inside-work-tree` before suggesting/using git diff would avoid this retry.
## 26-05-06 12:53 — validation_tooling

Validating a small extension edit required repeated fallbacks: `pnpm exec tsc` was blocked by pre-existing workspace type errors in hashline-tools (`renderShell` API drift), `pnpm exec esbuild` pointed to a missing global binary, and `pnpm exec tsx` was unavailable. I worked around it with Node's `--experimental-strip-types` import check. A workspace-level lightweight syntax-check script that excludes known type drift, or fixed local dev dependencies, would prevent this retry chain.
