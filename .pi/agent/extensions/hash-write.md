# Hash-based file editing in `can1357/oh-my-pi`

This document describes the hash-based file editing approach used in the `can1357/oh-my-pi` fork of Pi.

## Summary

The fork does **not** primarily implement a hash-checked full-file `write` tool. Instead, it uses a **hashline edit protocol** for the `edit` tool:

- files are read with per-line anchors like `LINE#ID:content`
- edits refer to those anchors
- the tool recomputes hashes before applying changes
- if the file changed since it was read, the edit is rejected before mutation

This is a form of **line-addressed optimistic concurrency control**.

The plain `write` tool still does a normal whole-file overwrite. Its only hash-related behavior is that it can strip accidental `LINE#ID:` prefixes if the model copied them from `read` output.

---

## Repository/version examined

Repo: `https://github.com/can1357/oh-my-pi`

Commit examined:

- `8d8464df1a5e300fa3f003d64586be3cfbc2ea1b`

Useful source links:

- Hashline core:
  - <https://github.com/can1357/oh-my-pi/blob/8d8464df1a5e300fa3f003d64586be3cfbc2ea1b/packages/coding-agent/src/patch/hashline.ts>
- Edit tool integration:
  - <https://github.com/can1357/oh-my-pi/blob/8d8464df1a5e300fa3f003d64586be3cfbc2ea1b/packages/coding-agent/src/patch/index.ts>
- Read tool formatting:
  - <https://github.com/can1357/oh-my-pi/blob/8d8464df1a5e300fa3f003d64586be3cfbc2ea1b/packages/coding-agent/src/tools/read.ts>
- Write tool:
  - <https://github.com/can1357/oh-my-pi/blob/8d8464df1a5e300fa3f003d64586be3cfbc2ea1b/packages/coding-agent/src/tools/write.ts>
- Display mode settings:
  - <https://github.com/can1357/oh-my-pi/blob/8d8464df1a5e300fa3f003d64586be3cfbc2ea1b/packages/coding-agent/src/utils/file-display-mode.ts>
- Settings schema:
  - <https://github.com/can1357/oh-my-pi/blob/8d8464df1a5e300fa3f003d64586be3cfbc2ea1b/packages/coding-agent/src/config/settings-schema.ts>
- Hashline prompt shown to the model:
  - <https://github.com/can1357/oh-my-pi/blob/8d8464df1a5e300fa3f003d64586be3cfbc2ea1b/packages/coding-agent/src/prompts/tools/hashline.md>

---

## 1. What problem this approach is solving

Traditional LLM file editing approaches often use one of these patterns:

1. **Whole-file overwrite**
   - read the file
   - regenerate all content
   - write it back
   - simple, but fragile and noisy

2. **Text replacement**
   - find `oldText`
   - replace with `newText`
   - works, but can be ambiguous when the same text appears multiple times

3. **Patch/diff application**
   - more structured
   - still depends on stable surrounding context

The hashline approach tries to make edits more robust by saying:

> "Do not identify code by fuzzy surrounding text. Identify it by a line number plus a hash of the exact line content you saw when you read it."

That gives the system:

- a precise location
- a lightweight freshness check
- a way to fail safely when the file changed underneath the model

---

## 2. High-level idea

When the model reads a file in hashline mode, every line is prefixed with a tag:

```text
12#RZ:const value = 1;
13#PM:return value;
```

That tag contains:

- `12`: the 1-indexed line number
- `RZ`: a short hash derived from the line's content

Later, instead of saying "replace this old text", the model says something like:

```json
{
  "path": "file.ts",
  "edits": [
    {
      "loc": { "range": { "pos": "12#RZ", "end": "12#RZ" } },
      "content": ["const value = 2;"]
    }
  ]
}
```

Before applying the edit, Pi recomputes the hash for line 12 in the current file.

- If the hash still matches `RZ`, the edit is allowed.
- If it does not match, the edit is rejected as stale.

---

## 3. Where the feature is configured

The fork makes this the default editing mode.

In `settings-schema.ts`:

- `edit.mode` supports `replace`, `patch`, and `hashline`
- default is `hashline`
- `readHashLines` defaults to `true`

Relevant source:

- <https://github.com/can1357/oh-my-pi/blob/8d8464df1a5e300fa3f003d64586be3cfbc2ea1b/packages/coding-agent/src/config/settings-schema.ts#L909-L989>

So by default:

- the model sees hash-prefixed lines in `read`
- the `edit` tool expects hashline-style anchored edits

The README also describes `edit` as:

> In-place file editing with LINE#ID anchors

Source:

- <https://github.com/can1357/oh-my-pi/blob/8d8464df1a5e300fa3f003d64586be3cfbc2ea1b/README.md#L1222-L1230>

---

## 4. How read output is transformed

The formatting happens in `packages/coding-agent/src/tools/read.ts`.

The key helper is:

```ts
function prependHashLines(text: string, startNum: number): string {
  const textLines = text.split("\n");
  return textLines.map((line, i) => `${startNum + i}#${computeLineHash(startNum + i, line)}:${line}`).join("\n");
}
```

Source:

- <https://github.com/can1357/oh-my-pi/blob/8d8464df1a5e300fa3f003d64586be3cfbc2ea1b/packages/coding-agent/src/tools/read.ts#L86-L88>

So a normal file like:

```ts
const x = 1;
return x;
```

becomes something like:

```text
1#AB:const x = 1;
2#CD:return x;
```

The exact IDs depend on the hash function.

The decision to show hash lines is controlled by `resolveFileDisplayMode()`:

```ts
const hashLines =
  hasEditTool &&
  (settings.get("readHashLines") === true ||
    settings.get("edit.mode") === "hashline" ||
    Bun.env.PI_EDIT_VARIANT === "hashline");
```

Source:

- <https://github.com/can1357/oh-my-pi/blob/8d8464df1a5e300fa3f003d64586be3cfbc2ea1b/packages/coding-agent/src/utils/file-display-mode.ts#L19-L35>

This means the display mode is tied directly to the hashline editing strategy.

---

## 5. How the line hash is computed

The hash function lives in `packages/coding-agent/src/patch/hashline.ts`.

Core implementation:

```ts
export function computeLineHash(idx: number, line: string): string {
  line = line.replace(/\r/g, "").trimEnd();

  let seed = 0;
  if (!RE_SIGNIFICANT.test(line)) {
    seed = idx;
  }
  return DICT[Bun.hash.xxHash32(line, seed) & 0xff];
}
```

Source:

- <https://github.com/can1357/oh-my-pi/blob/8d8464df1a5e300fa3f003d64586be3cfbc2ea1b/packages/coding-agent/src/patch/hashline.ts#L36-L52>

### Important details

#### 5.1 Normalization

Before hashing a line:

- carriage returns (`\r`) are removed
- trailing whitespace is trimmed

This means the hash is intentionally **insensitive to CRLF vs LF** and to trailing spaces.

That reduces spurious mismatches caused by formatting noise.

#### 5.2 Hash algorithm

It uses:

- `xxHash32`
- only the low 8 bits (`& 0xff`)
- mapped through a custom 16-character alphabet twice to produce a 2-character ID

The alphabet is:

```ts
const NIBBLE_STR = "ZPMQVRWSNKTXJBYH";
```

Source:

- <https://github.com/can1357/oh-my-pi/blob/8d8464df1a5e300fa3f003d64586be3cfbc2ea1b/packages/coding-agent/src/patch/hashline.ts#L26-L32>

So although comments informally describe the IDs as hex-like, they are actually **custom two-character symbols**, such as `RZ`, `PM`, etc.

#### 5.3 Special handling for symbol-only lines

If a line contains no letters or digits, the line number is mixed into the hash seed:

```ts
if (!RE_SIGNIFICANT.test(line)) {
  seed = idx;
}
```

This is important because many code files contain repeated lines like:

- `}`
- `{`
- empty lines
- `);`

Without salting by line number, those lines would collide constantly.

The included tests explicitly verify this behavior:

- same symbol-only content on different lines should produce different hashes
- same alphanumeric content on different lines should produce the same hash

Test source:

- <https://github.com/can1357/oh-my-pi/blob/8d8464df1a5e300fa3f003d64586be3cfbc2ea1b/packages/coding-agent/test/core/hashline.test.ts#L20-L53>

---

## 6. Edit operations the model can express

The hashline prompt given to the model is in `prompts/tools/hashline.md`.

Source:

- <https://github.com/can1357/oh-my-pi/blob/8d8464df1a5e300fa3f003d64586be3cfbc2ea1b/packages/coding-agent/src/prompts/tools/hashline.md#L1-L120>

The prompt instructs the model to:

- read the file first
- copy anchors exactly from the latest read output
- batch all edits for one file into a single `edit` call
- re-read before editing the same file again

### Supported edit shapes

At the tool schema level, an edit entry has:

- `loc`: where to edit
- `content`: replacement/inserted lines

`loc` can be:

- `"append"` — append to end of file
- `"prepend"` — prepend to start of file
- `{ append: "N#ID" }` — insert after an anchored line
- `{ prepend: "N#ID" }` — insert before an anchored line
- `{ range: { pos: "N#ID", end: "N#ID" } }` — replace an inclusive line range

Schema and anchor resolution are implemented in:

- <https://github.com/can1357/oh-my-pi/blob/8d8464df1a5e300fa3f003d64586be3cfbc2ea1b/packages/coding-agent/src/patch/index.ts#L245-L324>

This is much more structured than a plain find/replace interface.

---

## 7. Parsing and validating anchors

An anchor string like `15#RZ` is parsed by `parseTag()`:

```ts
const match = ref.match(/^\s*[>+-]*\s*(\d+)\s*#\s*([ZPMQVRWSNKTXJBYH]{2})/);
```

Source:

- <https://github.com/can1357/oh-my-pi/blob/8d8464df1a5e300fa3f003d64586be3cfbc2ea1b/packages/coding-agent/src/patch/hashline.ts#L303-L319>

A parsed tag contains:

- `line`: numeric line number
- `hash`: 2-character ID

This parser is permissive about some display noise, but the essential requirement is still `LINE#ID`.

---

## 8. The key safety property: stale-read detection

This is the heart of the approach.

Before any changes are applied, `applyHashlineEdits()` validates every referenced anchor against the current file contents.

Relevant code:

- <https://github.com/can1357/oh-my-pi/blob/8d8464df1a5e300fa3f003d64586be3cfbc2ea1b/packages/coding-agent/src/patch/hashline.ts#L492-L539>

Validation logic:

```ts
const actualHash = computeLineHash(ref.line, fileLines[ref.line - 1]);
if (actualHash === ref.hash) {
  return true;
}
mismatches.push({ line: ref.line, expected: ref.hash, actual: actualHash });
```

If any mismatch exists, the tool throws `HashlineMismatchError` before mutating anything.

That means this behaves like optimistic concurrency:

1. model reads file
2. model prepares edits against that snapshot
3. file is checked again at apply time
4. if snapshot is stale, edit aborts

This is the main reason the approach is safer than naive whole-file overwrite or fuzzy replacement.

---

## 9. How mismatch errors are reported

`HashlineMismatchError` is designed to be useful to the model. It does not just say "hash mismatch"; it prints nearby context and the **updated** `LINE#ID` values.

Source:

- <https://github.com/can1357/oh-my-pi/blob/8d8464df1a5e300fa3f003d64586be3cfbc2ea1b/packages/coding-agent/src/patch/hashline.ts#L328-L394>

The message format is approximately:

```text
1 line has changed since last read. Use the updated LINE#ID references shown below (>>> marks changed lines).

    14#XY:previous line
>>> 15#AB:changed line now looks like this
    16#CD:next line
```

This is a good LLM-oriented design because it makes recovery straightforward:

- the agent can see the exact changed line
- it gets fresh anchors immediately
- it can retry with updated references

---

## 10. How edits are applied once validation passes

After validation succeeds, `applyHashlineEdits()` performs several cleanup and safety steps.

Source:

- <https://github.com/can1357/oh-my-pi/blob/8d8464df1a5e300fa3f003d64586be3cfbc2ea1b/packages/coding-agent/src/patch/hashline.ts#L543-L698>

### 10.1 Autocorrect of escaped tab indentation

If edit content uses leading literal `\t` sequences instead of actual tabs, the tool may auto-convert them to real tab characters.

This behavior is controlled by:

- `PI_HASHLINE_AUTOCORRECT_ESCAPED_TABS`

Default behavior is enabled.

Implementation:

- <https://github.com/can1357/oh-my-pi/blob/8d8464df1a5e300fa3f003d64586be3cfbc2ea1b/packages/coding-agent/src/patch/hashline.ts#L414-L444>

Tests:

- <https://github.com/can1357/oh-my-pi/blob/8d8464df1a5e300fa3f003d64586be3cfbc2ea1b/packages/coding-agent/test/core/hashline.test.ts#L576-L626>

### 10.2 Warning on suspicious duplicated closers/boundaries

A common LLM mistake is to replace a block body and include a closing `}` in the new content, but stop the replacement range one line too early. That leaves the original `}` in place and inserts another `}`.

The tool detects this pattern and emits a warning such as:

- your last replacement line matches the next surviving line
- maybe you should have extended `end` to include that line

Implementation:

- <https://github.com/can1357/oh-my-pi/blob/8d8464df1a5e300fa3f003d64586be3cfbc2ea1b/packages/coding-agent/src/patch/hashline.ts#L543-L573>

Tests:

- <https://github.com/can1357/oh-my-pi/blob/8d8464df1a5e300fa3f003d64586be3cfbc2ea1b/packages/coding-agent/test/core/hashline.test.ts#L520-L575>

### 10.3 Deduplication of identical edits

If the model emits the exact same edit twice, the tool deduplicates them before application.

Implementation:

- <https://github.com/can1357/oh-my-pi/blob/8d8464df1a5e300fa3f003d64586be3cfbc2ea1b/packages/coding-agent/src/patch/hashline.ts#L574-L611>

### 10.4 Bottom-up application

Edits are sorted so that lines later in the file are processed first.

Implementation:

- <https://github.com/can1357/oh-my-pi/blob/8d8464df1a5e300fa3f003d64586be3cfbc2ea1b/packages/coding-agent/src/patch/hashline.ts#L613-L698>

Why this matters:

- if line 10 is changed first, it can shift line numbers below it
- applying edits from bottom to top avoids invalidating later addresses

This is a classic strategy for line-based editing engines.

---

## 11. Integration in the `edit` tool

The `edit` tool dynamically supports multiple modes:

- `replace`
- `patch`
- `hashline`

The default is `hashline`.

Relevant code:

- <https://github.com/can1357/oh-my-pi/blob/8d8464df1a5e300fa3f003d64586be3cfbc2ea1b/packages/coding-agent/src/patch/index.ts#L446-L460>
- <https://github.com/can1357/oh-my-pi/blob/8d8464df1a5e300fa3f003d64586be3cfbc2ea1b/packages/coding-agent/src/patch/index.ts#L601-L807>

### Execution flow in hashline mode

When the edit tool runs in hashline mode, it does roughly this:

1. validate params are hashline-style
2. resolve file path
3. handle delete or move-only cases
4. if file does not exist, allow only anchorless append/prepend for creation
5. read file content
6. normalize BOM and line endings
7. resolve edit anchors
8. call `applyHashlineEdits()`
9. optionally merge imports
10. reject if the result is a no-op
11. restore original line ending style and BOM
12. write through LSP-aware path
13. generate diff/preview output

A key section:

- read and normalize original content
- apply anchor-based edits
- restore original endings
- produce compact diff preview

Source:

- <https://github.com/can1357/oh-my-pi/blob/8d8464df1a5e300fa3f003d64586be3cfbc2ea1b/packages/coding-agent/src/patch/index.ts#L691-L807>

### Preservation of formatting details

The edit path preserves:

- BOM
- original line ending style

This matters because the editing model internally normalizes to LF for safe line arithmetic, but the final written file is returned to its original newline format.

---

## 12. No-op detection

If the tool computes a result identical to the original file, it does not silently succeed. Instead, it raises an error explaining that no changes were made.

Implementation:

- <https://github.com/can1357/oh-my-pi/blob/8d8464df1a5e300fa3f003d64586be3cfbc2ea1b/packages/coding-agent/src/patch/index.ts#L711-L764>

This is helpful because LLMs often produce:

- the exact existing text
- formatting-only changes that normalize away
- duplicate insertions that result in no effective change

The tool tries to provide enough context for the model to recover intelligently.

---

## 13. Compact diff preview generation

After editing, the tool generates a compact preview that still carries hashline context.

Relevant code:

- <https://github.com/can1357/oh-my-pi/blob/8d8464df1a5e300fa3f003d64586be3cfbc2ea1b/packages/coding-agent/src/patch/hashline.ts#L739-L862>
- <https://github.com/can1357/oh-my-pi/blob/8d8464df1a5e300fa3f003d64586be3cfbc2ea1b/packages/coding-agent/src/patch/index.ts#L781-L806>

This is mostly UX, but it reinforces the same anchor-based model throughout the system.

---

## 14. The `write` tool: what is and is not hash-based

The `write` tool in this fork is not the same thing as the hashline edit system.

Its prompt is simple:

> Creates or overwrites file at specified path.

It also explicitly tells the model that it should prefer `edit` for modifying existing files.

Source:

- <https://github.com/can1357/oh-my-pi/blob/8d8464df1a5e300fa3f003d64586be3cfbc2ea1b/packages/coding-agent/src/prompts/tools/write.md#L1-L13>

### The actual write schema

The schema is just:

```ts
{
  path: string,
  content: string
}
```

Source:

- <https://github.com/can1357/oh-my-pi/blob/8d8464df1a5e300fa3f003d64586be3cfbc2ea1b/packages/coding-agent/src/tools/write.ts#L35-L41>

There is no `expectedHash`, `baseHash`, `etag`, `oldHash`, or compare-and-swap field.

### What hash awareness it does have

If hashline mode is active, and the content being written appears to include copied `LINE#ID:` prefixes, the tool strips them before writing.

Implementation:

- `stripWriteContent()`:
  - <https://github.com/can1357/oh-my-pi/blob/8d8464df1a5e300fa3f003d64586be3cfbc2ea1b/packages/coding-agent/src/tools/write.ts#L69-L82>
- `stripHashlinePrefixes()`:
  - <https://github.com/can1357/oh-my-pi/blob/8d8464df1a5e300fa3f003d64586be3cfbc2ea1b/packages/coding-agent/src/patch/index.ts#L193-L212>
- execution path:
  - <https://github.com/can1357/oh-my-pi/blob/8d8464df1a5e300fa3f003d64586be3cfbc2ea1b/packages/coding-agent/src/tools/write.ts#L266-L310>

The idea is:

- the model sees hashline prefixes during `read`
- sometimes it might paste them back into `write`
- the tool sanitizes that accidental formatting

This is a helpful compatibility feature, but it is **not** a hash-validated whole-file write protocol.

---

## 15. Why this approach is effective for LLMs

This design is well matched to common LLM failure modes.

### 15.1 It avoids ambiguous matches

With plain `oldText/newText`, the model can easily choose text that appears multiple times.

With hashline editing, the model must specify:

- exactly which line number
- exactly which hash it saw

That makes the target much less ambiguous.

### 15.2 It detects stale context cheaply

The model often operates on a stale mental snapshot.

Hashline validation gives a cheap way to detect that without requiring full structural analysis or a full-file checksum exchange.

### 15.3 It is resilient to line shifting in batched edits

Bottom-up application prevents index drift inside a single edit batch.

### 15.4 It is readable enough for the model

`LINE#ID:content` is short and visually simple. It is easier for a model to copy than a verbose AST path or full JSON node ID.

### 15.5 It fails with actionable information

Mismatch errors include updated anchors and context rather than only reporting failure.

That is a strong ergonomic choice for agent loops.

---

## 16. Tradeoffs and limitations

The approach is good, but it is not perfect.

### 16.1 The hash is intentionally short

The hash ID is only 2 characters from a 16-symbol alphabet, effectively 8 bits of information.

That means collisions are possible.

The system relies on the combination of:

- line number
- line content hash
- local edit structure

rather than on a strong cryptographic guarantee.

In practice this is often enough, but it is not collision-proof.

### 16.2 Line-number dependence means large upstream edits can invalidate many anchors

If many lines are inserted or deleted above the target area, previously read anchors become invalid.

That is not a bug; it is the intended stale-read detection behavior. But it does mean the model may need to re-read frequently.

### 16.3 It is line-oriented, not syntax-tree-oriented

This approach understands files as lines, not as AST nodes.

So it is stronger than fuzzy text replacement, but weaker than a true semantic edit engine.

### 16.4 Full-file `write` remains unsafe in the usual way

If the model uses `write` instead of `edit`, it can still overwrite an entire file without anchor validation.

The system mitigates this socially and via prompting:

- the prompt tells the model to prefer `edit`
- the tooling ecosystem makes hashline mode the default

But `write` itself is still a normal overwrite API.

---

## 17. Conceptual model: compare-and-swap for lines

A useful way to think about hashline mode is:

- **line number** = address
- **line hash** = version check
- **edit op** = mutation

So an anchor like `42#PM` means:

> "Apply this edit at line 42, but only if line 42 is still the exact content version I previously saw."

That is very similar to compare-and-swap logic in concurrent systems:

- read current state
- prepare mutation against that state
- apply only if state still matches expectations

The difference is that the state token is a short per-line hash rather than a full object version number.

---

## 18. End-to-end example

Suppose the file currently is:

```ts
function add(a, b) {
  return a + b;
}
```

A `read` in hashline mode might show:

```text
1#AA:function add(a, b) {
2#BC:  return a + b;
3#DE:}
```

The model wants to change the body. It sends:

```json
{
  "path": "math.ts",
  "edits": [
    {
      "loc": {
        "range": {
          "pos": "2#BC",
          "end": "2#BC"
        }
      },
      "content": ["  return Number(a) + Number(b);"]
    }
  ]
}
```

### If the file has not changed

The tool recomputes the hash for line 2.

- current line 2 still hashes to `BC`
- edit is applied

### If someone changed the file first

Suppose line 2 is now:

```ts
  return a - b;
```

Then line 2 will no longer hash to `BC`.

Result:

- edit fails
- no mutation occurs
- error reports updated anchor for line 2
- model must re-read or retry using the fresh anchor

That is the central safety property of the design.

---

## 19. Bottom line

The `can1357/oh-my-pi` fork uses a thoughtful **hashline-based edit protocol** rather than a cryptographically guarded whole-file write tool.

Its key characteristics are:

- `read` emits `LINE#ID:content`
- `edit` targets those anchors
- anchors are validated against current file state before mutation
- stale edits fail safely with useful recovery context
- edits are applied bottom-up to avoid line-shift problems
- the plain `write` tool is still a normal overwrite tool, with only a small compatibility feature that strips copied hashline prefixes

So the best description of the approach is:

> a line-addressed, hash-validated edit protocol designed to make LLM-driven code changes more precise, safer, and easier to recover when context goes stale.
