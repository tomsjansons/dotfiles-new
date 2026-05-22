# VENT

Feedback log. Repeated/systemic workflow friction that should become future automation, docs, or workflow fixes.

## 26-05-10 11:13 — symlinked_worktree_status

Git status/diff reported .pi/agent/extensions/hashline-tools/bash-tool.ts as deleted because .pi/agent/extensions is a symlink to .dotfiles/.pi/agent/extensions, while the edit/read tools followed the live symlink target. I had to repeat path/status checks from both the cwd and repo root to confirm the actual edited file. A workspace-aware diff/status helper that resolves symlink targets before invoking git would prevent this backtracking.
