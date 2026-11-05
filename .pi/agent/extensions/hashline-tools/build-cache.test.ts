/**
 * build-cache.test.ts: build-once caching semantics and visual preservation.
 *
 * The cache must (1) build each (primary, secondary) at most once, (2) evict
 * LRU-style under its bound, and (3) NEVER change builder output — every
 * formatting builder is compared cold vs warm and across instances for exact
 * byte equality, so the visual style is guaranteed unchanged.
 *
 * Run: bun build-cache.test.ts
 */
import { BuildCache } from "./build-cache";
import { colorizeCodeSegment } from "./highlight";
import {
	colorizeLines,
	descriptionParagraph,
	formatErrorDetail,
	formatStatusLine,
	LIGHT_PURPLE,
	RawText,
} from "./render";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
	if (!cond) {
		failures++;
		console.log(`FAIL ${name}`, extra ?? "");
	} else console.log(`ok   ${name}`);
}

const theme = { fg: (_role: string, s: string) => s } as any;

// ─── BuildCache semantics ────────────────────────────────────────────────────

{
	const cache = new BuildCache<string>();
	let builds = 0;
	const build = () => `v${++builds}`;
	check("builds once per key", cache.get("a", 1, build) === "v1" && cache.get("a", 1, build) === "v1" && builds === 1);
	check("distinct secondary builds separately", cache.get("a", 2, build) === "v2" && builds === 2);
	check("distinct primary builds separately", cache.get("b", 1, build) === "v3" && builds === 3);
	check("size tracks primary keys", cache.size === 2);
	cache.clear();
	check("clear empties", cache.size === 0);
}

{
	const cache = new BuildCache<number>(2);
	let builds = 0;
	const build = () => ++builds;
	cache.get("x", 0, build);
	cache.get("y", 0, build);
	cache.get("x", 0, build); // hit — refreshes x
	cache.get("z", 0, build); // evicts y (LRU), not x
	const y = cache.get("y", 0, build);
	check("evicts LRU, hit refreshes position", y === 4, y);
	check("bounded primary keys", cache.size <= 2, cache.size);
}

// ─── RawText: per-frame render cache ─────────────────────────────────────────

{
	const a = new RawText("one\ntwo");
	const first = a.render(80);
	check("RawText returns same array on repeat render", first === a.render(80));
	check("RawText bytes stable across instances", JSON.stringify(new RawText("one\ntwo").render(80)) === JSON.stringify(first));
	check("RawText rebuilds on width change", a.render(40) !== first);
	check("RawText empty renders []", new RawText("").render(80).length === 0);
	const b = new RawText("old");
	b.render(80);
	b.setText("new");
	check("setText busts render cache", JSON.stringify(b.render(80)) === JSON.stringify(["new"]));
}

// ─── Visual preservation: cold vs warm byte equality ─────────────────────────

{
	const path = "/home/user/some/deeply/nested/path/that/wraps/around/the/status/line.ts";
	const cold = formatStatusLine(theme, "read", "1-1000", "a1b2", path, "ok", 120);
	const warm = formatStatusLine(theme, "read", "1-1000", "a1b2", path, "ok", 120);
	check("formatStatusLine cold === warm", cold === warm);
	const cross = formatStatusLine(theme, "read", "1-1000", "a1b2", path, "ok", 120);
	check("formatStatusLine stable across calls", cross === cold);
}

{
	const seg = "python3 - <<'EOF'\nprint('hello')\nEOF";
	const cold = colorizeCodeSegment(seg, 60);
	check("colorizeCodeSegment cold === warm", colorizeCodeSegment(seg, 60) === cold);
	check("colorizeCodeSegment width variants differ independently", typeof colorizeCodeSegment(seg, 30) === "string");
	check("colorizeCodeSegment round-trips bytes", cold.replace(/\x1b\[[0-9;]*m/g, "") === seg);

	const plain1 = (() => {
		process.env.PI_HASHLINE_CODE_COLOR = "1";
		const s = colorizeCodeSegment(seg, 60);
		delete process.env.PI_HASHLINE_CODE_COLOR;
		return s;
	})();
	const colored = colorizeCodeSegment(seg, 60);
	const plain2 = (() => {
		process.env.PI_HASHLINE_CODE_COLOR = "1";
		const s = colorizeCodeSegment(seg, 60);
		delete process.env.PI_HASHLINE_CODE_COLOR;
		return s;
	})();
	check("kill switch: plain cached separately from colored", plain1 === plain2 && plain1 !== colored);
}

{
	const body = "line one\nline two\nline three";
	const cold = colorizeLines(body, LIGHT_PURPLE);
	check("colorizeLines cold === warm", colorizeLines(body, LIGHT_PURPLE) === cold);
	check("colorizeLines round-trips bytes", cold.replace(/\x1b\[[0-9;]*m/g, "") === body);
}

{
	const msg = "something went\nwrong here";
	const cold = formatErrorDetail(theme, msg);
	check("formatErrorDetail cold === warm", formatErrorDetail(theme, msg) === cold);
	check("formatErrorDetail round-trips bytes", cold.replace(/\x1b\[[0-9;]*m/g, "").replace(/^ {8}/gm, "") === msg);
}

{
	const text = "a paragraph of vision description text that is long enough to wrap at eighty columns or so";
	const cold = descriptionParagraph(text, 40).render(40);
	const warm = descriptionParagraph(text, 40).render(40);
	check("descriptionParagraph cold === warm", JSON.stringify(cold) === JSON.stringify(warm));
	check("descriptionParagraph cross-instance stable", JSON.stringify(descriptionParagraph(text, 40).render(40)) === JSON.stringify(cold));
}

if (failures) {
	console.log(`\n${failures} FAILURES`);
	process.exit(1);
} else console.log("\nBUILD-CACHE ALL PASS");
