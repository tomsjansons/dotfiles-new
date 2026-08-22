import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeFileHash, formatHeader, stripEchoedPrefixes, tagOnTagNote, unwrapHeaderPath } from "./format";
import { SnapshotStore } from "./store";
import { executeRead, getStashedImageRead } from "./read";
import { executeEdit } from "./edit";
import { Column, descriptionParagraph, LIGHTER_BLUE, RawText, shouldShowErrorDetail } from "./render";
import { getCapabilities, Image as TuiImage, setCapabilities, visibleWidth } from "@earendil-works/pi-tui";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
	if (!cond) {
		failures++;
		console.log(`FAIL ${name}`, extra ?? "");
	} else console.log(`ok   ${name}`);
}

// --- format ---
check("hash stable", computeFileHash("a\nb\n") === computeFileHash("a\nb\n"));
check("hash ignores CRLF + trailing ws", computeFileHash("a \r\nb\t\n") === computeFileHash("a\nb\n"));
check("hash 4 upper hex", /^[0-9A-F]{4}$/.test(computeFileHash("x")));
check("unwrap header", unwrapHeaderPath("[src/a.ts#1A2B]").tag === "1A2B" && unwrapHeaderPath("[src/a.ts#1A2B]").path === "src/a.ts");
check("unwrap plain", unwrapHeaderPath("src/a.ts").tag === undefined);

// shared parser: bare + bracketed, relative + absolute, case-insensitive tag
check("unwrap bare tag (no brackets)", unwrapHeaderPath("src/a.ts#1A2B").tag === "1A2B" && unwrapHeaderPath("src/a.ts#1A2B").path === "src/a.ts");
check("unwrap absolute bare, lowercase tag", unwrapHeaderPath("/abs/a.ts#1a2b").tag === "1A2B" && unwrapHeaderPath("/abs/a.ts#1a2b").path === "/abs/a.ts");
check("unwrap splits at last # (path contains #)", unwrapHeaderPath("foo#bar#AB12").path === "foo#bar" && unwrapHeaderPath("foo#bar#AB12").tag === "AB12");
check("unwrap bracketed #-path", unwrapHeaderPath("[foo#bar#AB12]").path === "foo#bar" && unwrapHeaderPath("[foo#bar#AB12]").tag === "AB12");
check("malformed non-hex tag", !!unwrapHeaderPath("[src/a.ts#ZZZZ]").malformed && unwrapHeaderPath("[src/a.ts#ZZZZ]").path === undefined);
check("malformed short tag", !!unwrapHeaderPath("src/a.ts#1A2").malformed);
check("malformed long tag", !!unwrapHeaderPath("src/a.ts#1A2B3").malformed);
check("malformed unbalanced open bracket", !!unwrapHeaderPath("[src/a.ts#1A2B").malformed);
check("malformed unbalanced close bracket", !!unwrapHeaderPath("src/a.ts#1A2B]").malformed);
check("malformed missing path", !!unwrapHeaderPath("#1A2B").malformed);
check("dotted # frag stays a plain path", unwrapHeaderPath("notes#1.md").path === "notes#1.md" && unwrapHeaderPath("notes#1.md").tag === undefined);
check("tag-on-tag note fires", !!tagOnTagNote("foo#AB12"));
check("tag-on-tag note quiet on clean path", tagOnTagNote("foo.ts") === undefined);

const echo = stripEchoedPrefixes("[f.ts#1A2B]\n1:hello\n2:world");
check("strip echoed read output", echo.stripped && echo.text === "hello\nworld");
const legit = stripEchoedPrefixes("1:first\nnot prefixed");
check("strip refuses non-uniform", !legit.stripped && legit.text === "1:first\nnot prefixed");

// --- render ---
const tooWide = "        57:" + "x".repeat(220);
check("RawText truncates rendered lines", new RawText(tooWide).render(80).every((line) => visibleWidth(line) <= 80));
check("plain read body containing Refused is not an error", !shouldShowErrorDetail(false, '12:const msg = "Refused";'));
check("real tool error still shows detail", shouldShowErrorDetail(true, '12:const msg = "Refused";'));

// --- store ---
const store = new SnapshotStore({ maxPaths: 3, maxVersionsPerPath: 2 });
const t1 = store.record("/a", "one\ntwo\n", [1, 2]);
check("record returns tag", t1 === computeFileHash("one\ntwo\n"));
const t1b = store.record("/a", "one\ntwo\n", [3]);
check("identical content fuses (same tag)", t1b === t1);
check("seenLines union on fusion", store.head("/a")?.seenLines?.has(3) === true && store.head("/a")?.seenLines?.has(1) === true);
store.record("/a", "changed\n");
check("new version unshifted", store.head("/a")?.text === "changed\n");
check("old version retained by tag", store.byHash("/a", t1)?.text === "one\ntwo\n");
store.record("/a", "third\n");
check("ring drops 3rd-oldest version", store.byHash("/a", t1) === null);
const tagCollisionText = "one\ntwo\n";
check("evicted tag resolves null", store.byHash("/a", t1) === null);
void tagCollisionText;

// --- read ---
const dir = mkdtempSync(join(tmpdir(), "hl-"));
const file = join(dir, "foo.ts");
writeFileSync(file, "l1\nl2\nl3\nl4\nl5\n");
const ctx = { cwd: dir, model: undefined, modelRegistry: undefined as any };
const r1 = await executeRead("c1", { path: "foo.ts" }, undefined, undefined, ctx);
const t = (r: any) => r.content[0].text as string;
console.log("--- read output ---\n" + t(r1) + "\n---");
check("read has header", t(r1).startsWith(`[foo.ts#${computeFileHash("l1\nl2\nl3\nl4\nl5\n")}]`));
check("read has N: prefixes", t(r1).includes("\n3:l3\n"));
const r2 = await executeRead("c2", { path: "foo.ts" }, undefined, undefined, ctx);
check("dedup stub on identical re-read", t(r2).includes("unchanged since last read"));
const r3 = await executeRead("c3", { path: "foo.ts" }, undefined, undefined, ctx);
check("stub self-expires", t(r3).includes("1:l1"));
const r4 = await executeRead("c4", { path: "foo.ts", offset: 99 }, undefined, undefined, ctx);
check("past-EOF is a note not error", t(r4).includes("beyond end of") && t(r4).includes("offset="), t(r4));
const dev = await executeRead("c5", { path: "/dev/zero" }, undefined, undefined, ctx);
check("device refused", t(dev).includes("Refused"));
const empty = join(dir, "empty.txt");
writeFileSync(empty, "");
const r5 = await executeRead("c6", { path: "empty.txt" }, undefined, undefined, ctx);
check("empty file note", t(r5).includes("is empty"));

// partial read → seenLines
writeFileSync(file, Array.from({ length: 50 }, (_, i) => `line${i + 1}`).join("\n"));
await executeRead("c7", { path: "foo.ts", offset: 1, limit: 10 }, undefined, undefined, ctx);

// --- edit validation ---
// blind edit on unseen lines must be denied
const tagHdr = formatHeader("foo.ts", computeFileHash(Array.from({ length: 50 }, (_, i) => `line${i + 1}`).join("\n")));
try {
	await executeEdit("e1", { path: tagHdr, edits: [{ oldText: "line30", newText: "LINE30" }] }, undefined, undefined, ctx);
	check("deny blind edit on unseen lines", false);
} catch (err: any) {
	check("deny blind edit on unseen lines", err.message.includes("never shown") && err.message.includes("offset=30"), err.message);
}
// seen edit must pass (unique multi-line anchor)
const ok = await executeEdit("e2", { path: tagHdr, edits: [{ oldText: "line7\nline8", newText: "LINE7\nline8" }] }, undefined, undefined, ctx);
check("seen edit passes", JSON.stringify(ok.content).includes("foo.ts#"));
// stale tag must be denied
try {
	await executeEdit("e3", { path: tagHdr, edits: [{ oldText: "LINE5", newText: "x" }] }, undefined, undefined, ctx);
	check("deny stale tag", false);
} catch (err: any) {
	check("deny stale tag", err.message.includes("changed on disk"), err.message);
}
// --- write ---
import { executeWrite } from "./write";
const w1 = await executeWrite("w1", { path: "new.ts", content: "a\nb\n" }, undefined, undefined, ctx);
check("write returns fresh tag header", t(w1).startsWith(`[new.ts#${computeFileHash("a\nb\n")}]`), t(w1));
const w2 = await executeWrite("w2", { path: "echo.ts", content: "[echo.ts#1234]\n1:x\n2:y" }, undefined, undefined, ctx);
check("write strips echoed prefixes", t(w2).includes("auto-stripped"), t(w2));
import { readFileSync } from "node:fs";
check("stripped content on disk", readFileSync(join(dir, "echo.ts"), "utf8") === "x\ny");
// drift guard: change file on disk out-of-band, then overwrite must be denied
writeFileSync(join(dir, "new.ts"), "SNEAKY OUT-OF-BAND CHANGE\n");
try {
	await executeWrite("w3", { path: "new.ts", content: "overwrite\n" }, undefined, undefined, ctx);
	check("deny drifted overwrite", false);
} catch (err: any) {
	check("deny drifted overwrite", err.message.includes("changed on disk"), err.message);
}
// untracked existing file: allowed with note
writeFileSync(join(dir, "untracked.ts"), "old\n");
const w4 = await executeWrite("w4", { path: "untracked.ts", content: "new\n" }, undefined, undefined, ctx);
check("untracked overwrite allowed with note", t(w4).includes("never read this session"), t(w4));

// --- write tag validation (fail closed) ---
writeFileSync(join(dir, "tagged.ts"), "v1\n");
await executeRead("c13", { path: "tagged.ts" }, undefined, undefined, ctx);
const v1Tag = computeFileHash("v1\n");
const w5 = await executeWrite("w5", { path: `[tagged.ts#${v1Tag}]`, content: "v2\n" }, undefined, undefined, ctx);
check("write with correct tag proceeds", t(w5).startsWith(`[tagged.ts#${computeFileHash("v2\n")}]`), t(w5));
const bogusTag = ["0000", "1111", "2222"].find((x) => x !== v1Tag && x !== computeFileHash("v2\n"))!;
try {
	await executeWrite("w6", { path: `[tagged.ts#${bogusTag}]`, content: "v3\n" }, undefined, undefined, ctx);
	check("write refuses unknown tag", false);
} catch (err: any) {
	check("write refuses unknown tag", err.message.includes("not tracked"), err.message);
}
try {
	await executeWrite("w7", { path: `[tagged.ts#${v1Tag}]`, content: "v3\n" }, undefined, undefined, ctx);
	check("write refuses stale tag (drift vs passed tag)", false);
} catch (err: any) {
	check("write refuses stale tag (drift vs passed tag)", err.message.includes("changed on disk") && err.message.includes("plain path"), err.message);
}
try {
	await executeWrite("w8", { path: "[tagged.ts#ZZZZ]", content: "v3\n" }, undefined, undefined, ctx);
	check("write refuses malformed tag-like path", false);
} catch (err: any) {
	check("write refuses malformed tag-like path", err.message.includes("not a valid tag"), err.message);
}
check("no stray literal file created", !existsSync(join(dir, "[tagged.ts#ZZZZ]")) && readdirSync(dir).every((f) => !f.includes("ZZZZ")));

// untagged edit skips validation
const ok2 = await executeEdit("e4", { path: "foo.ts", edits: [{ oldText: "line30", newText: "LINE30" }] }, undefined, undefined, ctx);
check("untagged edit allowed", !!ok2);

// bare path#TAG (no brackets) must validate too — the complaint's failing form
const bareTag = computeFileHash(readFileSync(join(dir, "foo.ts"), "utf8"));
const okBare = await executeEdit("e5", { path: `foo.ts#${bareTag}`, edits: [{ oldText: "line9", newText: "LINE9" }] }, undefined, undefined, ctx);
check("edit with bare path#TAG validates", JSON.stringify(okBare.content).includes("foo.ts#"));
try {
	await executeEdit("e6", { path: "foo.ts#XYZ1", edits: [{ oldText: "line10", newText: "x" }] }, undefined, undefined, ctx);
	check("edit malformed tag → clear error, not ENOENT", false);
} catch (err: any) {
	check("edit malformed tag → clear error, not ENOENT", err.message.includes("not a valid tag") && !err.message.includes("ENOENT"), err.message);
}

// tag-on-tag: a literal '#'-named file gets a two-tag header + warning note
const w9 = await executeWrite("w9", { path: "odd#AB12#AB12", content: "odd\n" }, undefined, undefined, ctx);
check("tag-on-tag write warns in response", t(w9).includes("two tags") && t(w9).includes("odd#AB12"), t(w9));
const rOdd = await executeRead("c14", { path: "[odd#AB12#AB12]" }, undefined, undefined, ctx);
check("read round-trips a #-path header", t(rOdd).startsWith("[odd#AB12#") && t(rOdd).includes("two tags"), t(rOdd));

// --- vision fallback ---
import { describeImage, isVisionCapable, loadVisionFallbackConfig, resolveVisionFallbackModel } from "./vision";
import { writeFileSync as wfs } from "node:fs";

check("vision-capable model detected", isVisionCapable({ input: ["text", "image"] }));
check("text-only model detected", !isVisionCapable({ input: ["text"] }));
check("undefined model is not vision-capable", !isVisionCapable(undefined));
check("visionFallback config absent → undefined", (await loadVisionFallbackConfig()) === undefined);

// Fake registry: model found with/without auth, complete() returns a canned description.
const fakeVisionModel = { id: "Qwen/Qwen3.7-Flash", provider: "commandcode", input: ["text", "image"] };
const fakeCtx = {
	cwd: dir,
	model: { input: ["text"] }, // text-only session model
	modelRegistry: {
		find: (p: string, m: string) => (p === "commandcode" && m === "Qwen/Qwen3.7-Flash" ? fakeVisionModel : undefined),
		hasConfiguredAuth: (m: unknown) => m === fakeVisionModel,
		complete: async () => ({
			content: [{ type: "text", text: "A red circle on a white background." }],
		}),
	},
} as any;

const resolved = await resolveVisionFallbackModel(fakeCtx);
check("fallback model resolved", resolved === fakeVisionModel);

const png = join(dir, "img.png");
// Valid 2x2 PNG (built-in read needs a decodable image to return an image block)
wfs(png, Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC",
	"base64",
));
const rImg = await executeRead("c8", { path: "img.png" }, undefined, undefined, fakeCtx);
const tImg = t(rImg);
check("image read → vision description via fallback", tImg.includes("Described by commandcode/Qwen/Qwen3.7-Flash") && tImg.includes("A red circle"), tImg);
check("image read drops image block for text-only model", rImg.content.every((c: any) => c.type === "text"));
// Non-vision image read → the image + description are stashed for the TUI.
const stash8 = getStashedImageRead("c8");
check("non-vision image read stashes image for TUI", !!stash8 && stash8.mimeType === "image/png" && stash8.data.length > 0);
check("non-vision image read stashes description", stash8?.description === "A red circle on a white background.");
check("non-vision image read stashes describedBy", stash8?.describedBy === "commandcode/Qwen/Qwen3.7-Flash");

// No fallback configured (file absent) + non-vision model → text-only note, no error
const noFallbackCtx = { ...fakeCtx, modelRegistry: { ...fakeCtx.modelRegistry, find: () => undefined } };
const rNoFb = await executeRead("c9", { path: "img.png" }, undefined, undefined, noFallbackCtx);
check("no fallback → text-only, no error", t(rNoFb).includes("Read image file") && rNoFb.content.every((c: any) => c.type === "text"), t(rNoFb));

// Vision-capable session model → image block passes through untouched
const visionCtx = { ...fakeCtx, model: { input: ["text", "image"] } };
const rVis = await executeRead("c10", { path: "img.png" }, undefined, undefined, visionCtx);
check("vision model → image block preserved", rVis.content.some((c: any) => c.type === "image"));
// Vision image read → NO stash: the image block stays in content and core
// ToolExecutionComponent renders it (a stash would double the TUI preview).
const stash10 = getStashedImageRead("c10");
check("vision image read leaves no stash", stash10 === undefined);

// Kill switch: no vision call, image dropped, no error
process.env.PI_HASHLINE_VISION_DISABLE = "1";
const rKill = await executeRead("c11", { path: "img.png" }, undefined, undefined, fakeCtx);
check("kill switch → text-only, no error", t(rKill).includes("Read image file") && rKill.content.every((c: any) => c.type === "text"));
delete process.env.PI_HASHLINE_VISION_DISABLE;

// Fallback model fails → degrade to text-only note with reason, never hard-error
const failingCtx = {
	...fakeCtx,
	modelRegistry: {
		...fakeCtx.modelRegistry,
		complete: async () => {
			throw new Error("auth failed");
		},
	},
};
const rFail = await executeRead("c12", { path: "img.png" }, undefined, undefined, failingCtx);
check(
	"fallback failure → text-only note with reason",
	t(rFail).includes("Vision fallback (commandcode/Qwen/Qwen3.7-Flash) failed: auth failed") && rFail.content.every((c: any) => c.type === "text"),
	t(rFail),
);

// Configured model not vision-capable → treated as no usable fallback
const textOnlyModel = { id: "deepseek/deepseek-v4-flash", provider: "commandcode", input: ["text"] };
const badFallbackCtx = {
	...fakeCtx,
	modelRegistry: {
		...fakeCtx.modelRegistry,
		find: (p: string, m: string) => (m === "Qwen/Qwen3.7-Flash" ? textOnlyModel : undefined),
	},
};
const rBad = await executeRead("c13", { path: "img.png" }, undefined, undefined, badFallbackCtx);
check("non-vision configured fallback → text-only, no error", rBad.content.every((c: any) => c.type === "text"), t(rBad));

// --- TUI render of a stashed image read (non-vision session) ---
// The stash from the earlier non-vision read (c8) is what renderResult consumes:
// header + Image + description paragraph (lighter blue).
const stashRender = getStashedImageRead("c8");
check("render stash present", !!stashRender);
if (stashRender) {
	// No terminal image support → Image falls back to "[Image: ...]".
	setCapabilities({ images: null, trueColor: true, hyperlinks: false });
	const img = new TuiImage(stashRender.data, stashRender.mimeType, { fallbackColor: (s) => s }, { maxWidthCells: 60 });
	const fallbackLines = img.render(80);
	check("no-caps image renders [Image: ...] fallback", fallbackLines.length === 1 && fallbackLines[0].includes("[Image:"), fallbackLines[0]);

	// Description paragraph renders wrapped, lighter blue, full text.
	const desc = descriptionParagraph("A red circle on a white background.", 30);
	const descLines = desc.render(30);
	check("description renders at least one line", descLines.length >= 1 && descLines.join(" ").includes("A red circle"));
	check("description uses lighter blue", descLines[0].includes(LIGHTER_BLUE));

	// Column stacks header + image + description in order.
	const header = new RawText("✓ ↑ img.png");
	const col = new Column([header, img, desc]);
	const colLines = col.render(80);
	check("column renders header first", colLines[0] === "✓ ↑ img.png");
	check("column contains fallback image line", colLines.some((l) => l.includes("[Image:")));
	check("column contains description", colLines.some((l) => l.includes("A red circle")));

	// Kitty-capable terminal → Image emits the kitty graphics sequence.
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
	const kittyLines = new TuiImage(stashRender.data, stashRender.mimeType, { fallbackColor: (s) => s }, { maxWidthCells: 60 }).render(80);
	check("kitty image emits graphics sequence", kittyLines.some((l) => l.includes("\x1b_G") || l.includes("\x1b]1337;File=")), kittyLines.filter((l) => l.includes("\x1b")).slice(0, 1).join(""));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
