# hashline-tools

Pi extension that replaces the built-in `read`, `edit`, and `write` tools with a hashline workflow inspired by oh-my-pi.

## What it does

- `read`
  - returns text files as `LINE#ID:content`
  - preserves `offset` / `limit`
  - truncates output with pi's standard limits
  - delegates image reads to pi's built-in image-capable read tool

- `edit`
  - expects hashline edits using anchors copied from the latest `read`
  - supports:
    - `"append"`
    - `"prepend"`
    - `{ append: "LINE#ID" }`
    - `{ prepend: "LINE#ID" }`
    - `{ range: { pos: "LINE#ID", end: "LINE#ID" } }`
  - hard cutover: only `{ loc, content }` hashline edit blocks are accepted
  - rejects stale edits if anchored lines changed since the file was read
  - applies edits bottom-up
  - preserves BOM and original line endings
  - shows live line/word totals for streamed edit content

- `find`
  - finds files in a directory recursively
  - supports a glob-style `pattern` filter
  - matches path patterns against both the displayed path and the search-root-relative path, so `*/index.ts` works from `.`
  - respects `.gitignore`, `.ignore`, and `.piignore` files while walking directories
  - skips `.git/`, `.jj/`, `.svn/`, and `node_modules/` by default
  - emits a sorted file list plus the full per-file first-level LSP outline with hashline prefixes when available
  - falls back to a hashline preview of lines `1-20` only when the file has no outline

- `write`
  - behaves like pi's built-in write tool
  - strips accidental `LINE#ID:` prefixes if copied from hashline `read` output
  - shows live line/word totals for streamed file content
## Activation

This extension lives in `~/.pi/agent/extensions/hashline-tools/`, so pi auto-discovers it.

Install dependencies after pulling changes:

```bash
cd ~/.pi/agent/extensions/hashline-tools && npm install
```

Reload pi resources after changes:

```text
/reload
```


The extension also adds a `find` tool for multi-file directory inspection with LSP outlines.
