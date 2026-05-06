# at-preload

Pi extension that detects `@path` mentions in the user's prompt and preloads them before the turn starts.

## What it does

- `@file`
  - preloads lines `1-1000`
  - formats them with `LINE#ID:content` hash markers
  - injects the preload into model context before the turn starts

- `@directory`
  - preloads an ordered recursive path list capped at `100` rows
  - reports total files, total entries, and whether the listing was truncated
  - suggests searching the directory when more paths are needed
  - uses plain paths without hash prefixes
  - injects that listing into model context before the turn starts

- UI
  - renders preload rows like hashline `read` tool output
  - uses a double-up-arrow icon (`⇈`) for preloaded files and directories
  - directory rows show entries given to the agent and entries truncated when over the cap

## Mention syntax

Supported forms:

- `@src/index.ts`
- `@./src/index.ts`
- `@../package.json`
- `@/absolute/path`
- `@~`
- `@~/path/from/home`
- `@"path with spaces/file.ts"`
- `@'path with spaces/dir'`
- backtick-quoted paths are also supported, for example: `@` followed by `` `path with spaces/file.ts` ``

Notes about parsing:

- Bare mentions have trailing `),.;:!?` stripped.
- Duplicate mentions in the same prompt are deduplicated before preload.

## Notes

- File preloads are limited to the first `1000` lines.
- Directory preloads load structure only, not file contents.
- Directory listings are plain ordered paths, not visual trees.
- Directory listings are capped at `100` rows and include total file/entry counts so the agent knows when to search for more paths.
- Directory listings recurse, respect `.gitignore`, `.ignore`, and `.piignore`, and show symlinks as `path@ -> target`.
- Directory listings also apply default ignores for `.git/`, `.jj/`, `.svn/`, and `node_modules/`.
- Binary and image files are detected and skipped as text preloads.
- Missing or unsupported paths are included in model context as warnings.
- Only the latest preload context is kept in model context; older visible summaries may remain in session history.

## Reload

After editing the extension, run:

```text
/reload
```