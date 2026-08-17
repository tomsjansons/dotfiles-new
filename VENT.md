# VENT

Feedback log. Repeated/systemic workflow friction that should become future automation, docs, or workflow fixes.

## 26-08-14 07:21 — write-tag-header-trap

write tool accepts a [path#TAG] header (as its own description and the read tool's description instruct), but silently treats the literal string as the filename instead of stripping/validating the tag — creating a real file named "SKILL.md#BFE8" with no error. The refusal message ("re-read then rewrite") plus the read header display ("[SKILL.md#BFE8]") push the agent into this trap. Fix: either implement tag validation in write (parse #TAG, write to the real path, refuse on mismatch like edit does) or strip the tag with a clear notice; at minimum, document that write takes a plain path only and reject '#' in filenames.
## 26-08-17 08:45 — edit-tool-enoent-tag-format

The edit tool failed twice with ENOENT when passing the read-output tag as a path — first as `.zshrc#AD42` (relative) and then as `/home/toms/.dotfiles/.zshrc#AD42` (absolute). Only the literal bracketed header `[.zshrc#AD42]` was accepted. The guidance says "pass that whole header as the path", but the natural interpretations (bare path#tag, with or without brackets, relative or absolute) mostly fail; requiring the exact bracketed string is non-obvious and cost two failed attempts. Consider accepting path#tag without brackets, or documenting the exact expected format in the tool error message.
