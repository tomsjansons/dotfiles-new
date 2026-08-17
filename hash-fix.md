# The `SKILL.md#BFE8` incident — misleading elements and chain of thought

Date: 2026-08-14
Affected artifact: `.agents/skills/ssh-sudo-pwd/` (temporarily contained a stray file literally named `SKILL.md#BFE8`)

## What happened (one paragraph)

While generifying the `ssh-sudo-pwd` skill, my first `write` was refused because the file had changed on disk since my last `read`. I re-read the file, got the header `SKILL.md#BFE8`, and — following the tool descriptions — passed that header back as the path to `write`. Instead of validating the tag and writing to `SKILL.md`, the write tool treated `SKILL.md#BFE8` as a **literal filename** and silently created a second file. The generic content landed in `SKILL.md#BFE8`; the stale content stayed in `SKILL.md`. Fixed by copying the generic file over `SKILL.md` and deleting the stray file.

## The misleading elements

### 1. The read tool's output header — displays the tag *as if part of the path*

```
[.agents/skills/ssh-sudo-pwd/SKILL.md#BFE8]
```

The header looks exactly like a path with a hash in the filename. Nothing visually distinguishes the `#TAG` from the real path.

### 2. The read tool description — instructs passing the header back as the path

> Text output is prefixed with a [path#TAG] header; the TAG identifies the exact file version you saw — pass the [path#TAG] header as the path when calling edit or write to validate against that version.

This is the explicit instruction I followed. It covers both `edit` and `write`.

### 3. The write tool description — claims the tag is validated

> If the path is a [path#TAG] header from read output, the tag is validated before writing. Successful writes return a fresh [path#TAG] header for immediate follow-up edits.

This says the mechanism exists for `write`. It does not — the implementation treats the string literally.

### 4. The refusal error that pushed the sequence

> Write refused: .agents/skills/ssh-sudo-pwd/SKILL.md changed on disk since the last read (tag #3581 no longer matches). Read it again to see the current content, then rewrite.

"Read it again, then rewrite" + "pass the [path#TAG] header as the path" = pass the fresh tag. The loop is internally consistent and leads straight into the trap.

## Chain of thought

1. **Task**: generify the skill, remove all project-specific names.
2. First `write` with generic content → **refused**: file changed on disk (tag #3581 stale). Note: the file had been partially edited by something else (or an earlier session) — that was my first signal the file was being concurrently modified.
3. Re-`read` the file → header `[SKILL.md#BFE8]` displayed.
4. Recalled the tool descriptions: *"pass the [path#TAG] header as the path when calling edit or write"* and *"the tag is validated before writing"*.
5. Passed `SKILL.md#BFE8` as the write path. **No refusal, no warning** — write returned a fresh tag `SKILL.md#BFE8#CD51`, which looked like success.
6. **The tell-tale I missed**: a correct tagged write should have returned `SKILL.md#<newtag>`, not `SKILL.md#BFE8#CD51` (tag appended to a path that already had a tag). The response was the first evidence the tag was treated as filename content — but it still *looked* plausible, so I did not flag it.
7. Verification step (ls of the skill dir) revealed two files: `SKILL.md` (stale) and `SKILL.md#BFE8` (generic). Only then was the divergence obvious.

## What the correct behavior should be

- **write with a tagged path**: strip `#TAG`, validate against the current file, write to the real path, refuse on mismatch (like `edit` does). If validation isn't implemented, strip the tag and proceed with a notice.
- **At minimum**: document that `write` takes a plain path; reject paths containing `#` with a clear error instead of silently creating a wrong-named file.
- **For the agent**: when a tool response looks odd (tag-on-tag), verify with `ls` immediately. Passing the plain path to `write` is always safe — the tag is only ever a validation token, never part of the filename.

## Prevention

- Logged to `VENT.md` (vent: `write-tag-header-trap`).
- Future reads of a `[path#TAG]` header should treat `#TAG` as metadata, and `write` calls should use the plain path.
