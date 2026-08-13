# Pi doom-loop prevention extensions and packages

_Researched 2026-08-12._

## Executive summary

The Pi ecosystem has five packages that credibly address repeated or stuck behavior, but it is young and none has long-term maturity evidence. The clear first choice is **[`pi-loop-police`](https://pi.dev/packages/pi-loop-police)**: it is the only candidate found that combines streaming repetition detection, cross-turn stagnation heuristics, deterministic pre-execution tool blocking, recovery guidance, persistent configuration, and recent active releases. Its source is public at [`sebaxzero/pi-loop-police`](https://github.com/sebaxzero/pi-loop-police).

The other packages are narrower:

| Package | Detects | Response | Assessment |
|---|---|---|---|
| [`pi-loop-police`](https://pi.dev/packages/pi-loop-police) | Repetitive text/reasoning, rereads, search expansion, arbitrary exact tool cycles | Abort, sanitize, guide, and pre-call block | **Best overall** |
| [`pi-loop-guard`](https://pi.dev/packages/pi-loop-guard) | Exact identical turns and `ABAB` turns | Post-turn steering | Simple, limited |
| [`pi-deadloop`](https://pi.dev/packages/pi-deadloop) | Period-2/3 tool cycles, reasoning similarity, rereads, search patterns | Post-turn steering | Broader heuristics, compatibility risk |
| [`pi-loop-breaker`](https://pi.dev/packages/pi-loop-breaker) | Repeated error-result fingerprints | Abort current run | Useful failure-specific circuit breaker |
| [`pi-repeat-tool-guard`](https://pi.dev/packages/pi-repeat-tool-guard) | Exact repeated calls in a time window | Append reminder to result | Soft reminder, not really a guard |

**Recommendation:** trial `pi-loop-police` first in a disposable or non-critical Pi setup:

```sh
pi install npm:pi-loop-police
```

Tune or disable noisy detectors rather than running all defaults uncritically. If its breadth produces false positives, a small local extension built on Pi's `tool_call` and `tool_result` events may be preferable to one of the weaker packages.

## Findings

### 1. `pi-loop-police` — strongest candidate

- Package: [`pi-loop-police`](https://www.npmjs.com/package/pi-loop-police)
- Pi gallery: <https://pi.dev/packages/pi-loop-police>
- Source: <https://github.com/sebaxzero/pi-loop-police>
- Main implementation: [`extensions/loop-police.ts`](https://github.com/sebaxzero/pi-loop-police/blob/master/extensions/loop-police.ts)
- Installation documented by the package:

  ```sh
  pi install npm:pi-loop-police
  # or
  pi install git:github.com/sebaxzero/pi-loop-police.git
  ```

The package implements ten deterministic detectors covering:

- verbatim and fingerprint-based semantic repetition in streamed thinking/output;
- similar reasoning across turns;
- excessive reads of one file;
- rereading an unchanged file;
- repeated searches over expanding paths;
- repeated tool-call sequences, including cycles longer than `ABAB`;
- recurrence of already-detected reasoning.

The documented defaults include 80/100-character minimum repeated thinking/output blocks, three semantic repetitions, four stagnant turns at 0.85 Jaccard similarity, 20 reads per path, three paths for repeated search expansion, and a ten-read reread window with 40% redundancy. Tool-loop bans support disabled, temporary adjacency, and session-long modes. All detectors can be tuned or disabled through `/loop-police`, and configuration can be persisted in `loop-police.json`. See the [gallery configuration reference](https://pi.dev/packages/pi-loop-police) and [source](https://github.com/sebaxzero/pi-loop-police/blob/master/extensions/loop-police.ts).

Unlike post-turn reminders, it can stop repeated streamed text with `ctx.abort()`, trim contaminated reasoning/output, inject recovery guidance, and block a problematic `tool_call` before execution. That combination makes it the only package found that can prevent at least some wasted calls rather than merely comment on them afterward.

Potential false positives include intentionally repetitive structured output, paged reads of large files, legitimate reference-file rereads, polling, and deliberately repeated searches. Tool-cycle matching is exact and adjacent, so interleaved calls can evade it; its semantic checks remain heuristics. These limitations follow from the detector implementation and documented configuration rather than from an outcome-aware definition of “progress.”

At research time npm reported version `1.14.1`; releases ran from `1.0.0` on 2026-06-22 through `1.14.1` on 2026-08-11. This is encouraging activity, but still only weeks of history. Release metadata is available from the [npm registry](https://registry.npmjs.org/pi-loop-police).

### 2. `pi-loop-guard` — exact-call cycle steering

- Package/gallery: <https://pi.dev/packages/pi-loop-guard>
- Source: <https://github.com/GDWhisper/pi-loop-guard>
- Install: `pi install npm:pi-loop-guard`

At `turn_end`, the extension fingerprints each turn's tool-call list using tool names and serialized arguments. It recognizes consecutive identical turns (`AAAA…`) and alternating two-turn cycles (`ABAB…`). Defaults in `.pi/loop-guard.json` are `maxRepeats=5`, `windowSize=5`, and `enabled=true`; see its [README and source](https://github.com/GDWhisper/pi-loop-guard).

On detection it injects a recovery steering message and clears its in-memory history. It does **not** block the next call or call `ctx.abort()`, despite stronger “forced interruption” phrasing in the README. Detection is exact rather than semantic, happens after execution, recognizes only constant and period-two cycles, and does not assess tool results or actual progress.

Version `1.0.4` and all earlier versions were published on 2026-07-12 according to the [registry](https://registry.npmjs.org/pi-loop-guard); there was little subsequent maintenance evidence at research time.

### 3. `pi-deadloop` — broader post-turn heuristics

- Package/gallery: <https://pi.dev/packages/pi-deadloop>
- npm: <https://www.npmjs.com/package/pi-deadloop>
- Published source: <https://cdn.jsdelivr.net/npm/pi-deadloop@0.3.0/index.ts>
- Install: `pi install npm:pi-deadloop`

Its sliding post-turn window checks period-2/3 tool sequences, word-set Jaccard similarity across reasoning, repeated reads of one file, and repeated or progressively expanded searches. Defaults include a ten-turn window, four similar reasoning turns at 0.85 similarity, and a minimum six-call sequence repeated three times. Runtime settings are exposed through `/deadloop key=value`; inspect the [published implementation](https://cdn.jsdelivr.net/npm/pi-deadloop@0.3.0/index.ts).

Detection injects a `deliverAs: "steer"` diagnosis and prunes detector history. It does not abort, block, terminate, or remove prior transcript content. It also acts after calls have run, recognizes only period-2/3 cycles, and uses simple argument summaries. The reread heuristic does not robustly account for intervening edits.

The published manifest has no repository and peers on the former `@mariozechner/pi-coding-agent` package name rather than the current `@earendil-works/pi-coding-agent`, so compatibility should be tested. Version `0.3.0` was last published 2026-05-08; metadata is in the [npm registry](https://registry.npmjs.org/pi-deadloop).

### 4. `pi-loop-breaker` — repeated failures only

- Package/gallery: <https://pi.dev/packages/pi-loop-breaker>
- Source: <https://github.com/apetersson/pi-loop-breaker>
- Install: `pi install npm:pi-loop-breaker`

This extension examines tool-result text at `turn_end`. It fingerprints failures as the tool name plus the first 200 normalized characters of error-like output, then tracks consecutive repeats, repeats within a sliding window, and total failures. Its environment-variable defaults are three consecutive failures, five failures in a ten-result window, and twelve total failures. See the [README/source](https://github.com/apetersson/pi-loop-breaker).

When a threshold is hit, it calls `ctx.abort()` and warns in the UI. This is a useful circuit breaker for repeatedly failing commands, but it cannot see repeated successful calls that make no progress. Detection is string-based and post-execution, and its state resets at `agent_end`.

The package imports/peers on the old `@mariozechner/pi-coding-agent` name, which is a compatibility risk. Version `0.2.0` and the repository were last updated on 2026-02-28 according to [npm metadata](https://registry.npmjs.org/pi-loop-breaker) and the repository.

### 5. `pi-repeat-tool-guard` — reminder rather than guard

- Package/gallery: <https://pi.dev/packages/pi-repeat-tool-guard>
- npm: <https://www.npmjs.com/package/pi-repeat-tool-guard>
- Published source: <https://cdn.jsdelivr.net/npm/pi-repeat-tool-guard@0.1.0/src/index.ts>
- Install: `pi install npm:pi-repeat-tool-guard`

At `tool_result`, it counts exact `toolName + JSON.stringify(input)` matches. On the fourth and later match, it appends a reminder asking the model not to repeat the action. Entries expire after five minutes and its map is capped at 1,000; see the [published source](https://cdn.jsdelivr.net/npm/pi-repeat-tool-guard@0.1.0/src/index.ts).

It neither blocks nor aborts. Exact serialization is sensitive to argument and key-order differences, and time-window frequency is not the same as detecting an adjacent loop or lack of progress. Only version `0.1.0` was published, on 2026-05-06. Its manifest points to `Kingwl/pi-repeat-tool-guard`, but that repository returned 404 at research time; only the npm artifact remained inspectable through the [registry](https://registry.npmjs.org/pi-repeat-tool-guard).

## Adjacent option: Pi Fabric ambient supervision

[`pi-fabric`](https://pi.dev/packages/pi-fabric) is actively maintained and offers an ambient supervisor, but it is **not a deterministic loop guard**. The supervisor creates a separate observer-model actor subscribed by default to `agent_settled` and `tool_error`. Its prompt asks the observer to stay silent while work progresses and to message on drift, a stuck failure, missing work, or a concrete next action. The implementation is documented in Fabric's [`fabric-ambient` skill](https://cdn.jsdelivr.net/npm/pi-fabric@0.49.2/skills/fabric-ambient/SKILL.md) and [setup program](https://cdn.jsdelivr.net/npm/pi-fabric@0.49.2/skills/fabric-ambient/references/setup.md).

It maintains no deterministic call fingerprints, counters, or result comparisons and does not intercept `tool_call`. Because `agent_settled` fires only when the main session becomes idle, a continuously tool-calling agent may never trigger that observation. It can complement a deterministic guard by spotting semantic goal drift, but adds model cost and nondeterministic judgment and is not a real-time circuit breaker.

## What Pi itself exposes for a robust local guard

Pi's official [extension documentation](https://pi.dev/docs/latest/extensions) provides the necessary hooks:

- **`tool_call`** fires before execution and can return `{ block: true, reason, terminate? }`. This is the right place for deterministic prevention. `terminate` applies only to blocked calls, and in a parallel batch early termination occurs only if every finalized result terminates.
- **`tool_result`** exposes input, content, details, error status, and usage after execution. It is the right place to fingerprint outcomes and determine whether repeated calls changed anything, but it cannot prevent the just-completed call.
- **`turn_end`** supports cross-turn pattern and reasoning analysis, necessarily after that turn's work.
- **`message_update`** enables stream-time repetition detection; `ctx.abort()` can interrupt the active agent operation.
- **`agent_settled`** occurs only after retries, compaction, and queued continuation finish, making it useful for completion observers but too late for an active loop.
- **`pi.sendMessage(..., { deliverAs: "steer" })`** can place recovery guidance before the next model call. `pi.sendUserMessage` is heavier because it creates a visible user message and triggers a turn.
- **`ctx.shutdown()`** gracefully exits Pi and is usually too destructive for ordinary loop recovery.

The local Pi `0.84.1` documentation confirms the `tool_call` block contract and `tool_result` middleware behavior in `docs/extensions.md`; the public equivalents are the [official docs](https://pi.dev/docs/latest/extensions) and Pi's [`types.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts) / [`runner.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/runner.ts).

A high-quality custom detector would combine these hooks rather than merely count calls:

1. Normalize tool name and arguments at `tool_call`.
2. Record an outcome fingerprint at `tool_result`—including errors, changed files, command exit status, and relevant output—not just the call itself.
3. Treat exact repeated calls with unchanged outcomes differently from legitimate polling, pagination, test reruns after edits, or iterative search narrowing.
4. Warn/steer first, then block the next matching call, then abort only after repeated recovery failure.
5. Reset or decay state on concrete progress, user input, session changes, and relevant writes/edits.
6. Keep per-tool exemptions and thresholds configurable.

## Conclusion

There is no long-established mature solution yet. **`pi-loop-police` is the only package found that is broad and intervention-capable enough to recommend for a trial.** `pi-loop-breaker` is a reasonable narrow alternative for repeated errors; `pi-loop-guard` and `pi-deadloop` are post-hoc steering aids; `pi-repeat-tool-guard` is only a reminder. Pi Fabric supervision is complementary semantic oversight, not a substitute for deterministic interception.
