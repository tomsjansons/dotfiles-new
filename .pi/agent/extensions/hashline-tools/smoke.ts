import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeFileHash, formatHeader, stripEchoedPrefixes, unwrapHeaderPath } from "./format";
import { SnapshotStore } from "./store";
import { executeRead } from "./read";
import { executeEdit } from "./edit";
import { RawText, shouldShowErrorDetail } from "./render";
import { visibleWidth } from "@earendil-works/pi-tui";

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
const ctx = { cwd: dir };
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

// untagged edit skips validation
const ok2 = await executeEdit("e4", { path: "foo.ts", edits: [{ oldText: "line30", newText: "LINE30" }] }, undefined, undefined, ctx);
check("untagged edit allowed", !!ok2);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
