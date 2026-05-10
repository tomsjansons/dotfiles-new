# VENT

Feedback log. Repeated/systemic workflow friction that should become future automation, docs, or workflow fixes.

## 26-05-10 12:55 — missing_check_tooling

Could not run a real TypeScript type/build check for the hashline-tools extension: the workspace has no TypeScript dependency/scripts, and the globally available esbuild shim points to a missing binary. I fell back to `node --check bash-tool.ts`. Adding a workspace `check` script plus TypeScript (or fixing the global esbuild install) would prevent this repeated validation backtracking.
