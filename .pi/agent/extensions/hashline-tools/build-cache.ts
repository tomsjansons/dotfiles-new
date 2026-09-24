/**
 * build-cache.ts — build-once caching for the hashline render path.
 *
 * The TUI rebuilds tool rows far more often than their content changes:
 * streaming partial results re-run renderCall/renderResult on every chunk, and
 * the pending spinner ticks `ctx.invalidate()` at 10 Hz (render.ts), each tick
 * re-running both renderers through ToolExecutionComponent.updateDisplay().
 * Between rebuilds, every frame calls Component.render() on every row again.
 *
 * This module hides "build each expensive pure artifact at most once per
 * input" behind a single method. All hashline builders (syntax coloring, shell
 * splitting, path wrapping, body colorizing, line splitting/truncation) are
 * pure, so caching cannot change their output — visuals stay byte-identical.
 *
 * Interface contract:
 *   - `build` MUST be pure for the lifetime of the cache (same inputs → same
 *     output, no dependency on mutable state like spinners or env vars). Callers
 *     that need impure per-call behavior (e.g. the spinner glyph) must keep it
 *     OUTSIDE the cached builder and compose afterwards.
 *   - Values returned from `get` are shared between callers — treat them as
 *     immutable (do not mutate arrays/strings in place).
 *   - `primary` is typically the full content string; it is used as a Map key
 *     directly (no key concatenation, so large strings are not re-allocated).
 */

export class BuildCache<T> {
	#outer = new Map<string, Map<string | number, T>>();
	#maxPrimary: number;

	/**
	 * @param maxPrimary bound on distinct primary keys (LRU by insertion,
	 *                   refreshed on hit). Secondary maps are unbounded but in
	 *                   practice keyed by terminal width or a color SGR.
	 */
	constructor(maxPrimary = 512) {
		this.#maxPrimary = maxPrimary;
	}

	get(primary: string, secondary: string | number, build: () => T): T {
		let inner = this.#outer.get(primary);
		if (inner) {
			const hit = inner.get(secondary);
			if (hit !== undefined) {
				// Refresh LRU position.
				this.#outer.delete(primary);
				this.#outer.set(primary, inner);
				return hit;
			}
		} else {
			if (this.#outer.size >= this.#maxPrimary) {
				const eldest = this.#outer.keys().next().value;
				if (eldest !== undefined) this.#outer.delete(eldest);
			}
			inner = new Map();
			this.#outer.set(primary, inner);
		}
		const value = build();
		inner.set(secondary, value);
		return value;
	}

	clear(): void {
		this.#outer.clear();
	}

	get size(): number {
		return this.#outer.size;
	}
}
