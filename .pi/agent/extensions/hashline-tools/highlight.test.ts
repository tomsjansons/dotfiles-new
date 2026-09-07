/**
 * highlight.ts unit test: segment detection (python/node inline + heredoc),
 * byte-faithful reassembly (stripAnsi round-trip), per-line ANSI discipline,
 * and the PI_HASHLINE_CODE_COLOR kill switch.
 *
 * Run: node highlight.test.ts
 */
import { colorizeCodeSegment, colorizeCodeLines } from "./highlight";
import { DARK_BLUE, stripAnsi, wrapPath } from "./render";

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
	if (!cond) {
		failures++;
		console.log(`FAIL ${name}`, extra ?? "");
	} else console.log(`ok   ${name}`);
}

const RESET = "\x1b[39m";
const DARK_BLUE_SGR = "\x1b[38;2;30;136;229m";

/** Byte-faithful check: removing ANSI returns the exact input segment. */
function roundTrips(seg: string, colored: string): boolean {
	return stripAnsi(colored) === seg;
}

/** Every SGR color run in the line is exactly the given SGR (i.e. flat color). */
function allRuns(line: string, sgr: string): boolean {
	const runs = line.match(/\x1b\[38;2;\d+;\d+;\d+m/g) ?? [];
	return runs.length > 0 && runs.every((r) => r === sgr);
}

/** Line is flat dark blue (every color run). */
function flatDarkBlue(line: string): boolean {
	return !line.includes("\x1b[") || allRuns(line, DARK_BLUE_SGR);
}

/** Every line is either plain or color-wrapped (starts with a truecolor SGR, ends with reset). */
function perLineDiscipline(colored: string): boolean {
	return colored.split("\n").every((line) => {
		if (line === "") return true;
		if (!line.includes("\x1b[")) return true;
		return line.startsWith("\x1b[38;2;") && line.endsWith(RESET);
	});
}

// --- detection: inline python -------------------------------------------------
{
	const seg = "python3 -c 'print(\"hi\")'";
	const out = colorizeCodeSegment(seg);
	check("python -c: round-trips", roundTrips(seg, out), JSON.stringify(out));
	check("python -c: per-line discipline", perLineDiscipline(out));
	check("python -c: keyword colored", out.includes("\x1b[38;2;199;146;234mprint"), JSON.stringify(out));
	check("python -c: quote stays dark blue", out.includes(`${DARK_BLUE}'${RESET}`), JSON.stringify(out));
	check("python -c: no line explosion", out.split("\n").length === 1);
}
{
	const seg = 'python -c "import sys; print(sys.argv)"';
	const out = colorizeCodeSegment(seg);
	check("python -c double quotes: round-trips", roundTrips(seg, out));
	check("python -c double quotes: import keyword", out.includes("\x1b[38;2;199;146;234mimport"));
}
{
	const seg = "python3 -B -u -c 'print(1)'";
	const out = colorizeCodeSegment(seg);
	check("python flags before -c: round-trips", roundTrips(seg, out));
	check("python flags before -c: colored", out !== `${DARK_BLUE}${seg}${RESET}`);
}

// --- detection: inline node ---------------------------------------------------
{
	const seg = "node -e 'console.log(1 + 2)'";
	const out = colorizeCodeSegment(seg);
	check("node -e: round-trips", roundTrips(seg, out));
	check("node -e: .log colored as function", out.includes("\x1b[38;2;130;170;255mlog"), JSON.stringify(out));
}
{
	const seg = 'node --eval "const x = 42; // hi"';
	const out = colorizeCodeSegment(seg);
	check("node --eval: round-trips", roundTrips(seg, out));
	check("node --eval: const keyword", out.includes("\x1b[38;2;199;146;234mconst"));
	check("node --eval: comment gray", out.includes("\x1b[38;2;84;110;122m// hi"));
}
{
	const seg = "bun -e 'console.log(1)'";
	const out = colorizeCodeSegment(seg);
	check("bun -e: colored", out !== `${DARK_BLUE}${seg}${RESET}`);
}
{
	const seg = "node -pe '1 + 1'";
	const out = colorizeCodeSegment(seg);
	check("node -pe: round-trips", roundTrips(seg, out));
	check("node -pe: number colored", out.includes("\x1b[38;2;247;140;108m1"), JSON.stringify(out));
}

// --- detection: heredoc -------------------------------------------------------
{
	const seg = "python3 - <<'EOF'\nimport sys\nprint(sys.argv)  # dump\nEOF";
	const out = colorizeCodeSegment(seg);
	const lines = out.split("\n");
	check("python heredoc: line count preserved", lines.length === 4, JSON.stringify(lines));
	check("python heredoc: round-trips", roundTrips(seg, out));
	check("python heredoc: header dark blue", stripAnsi(lines[0]) === "python3 - <<'EOF'" && flatDarkBlue(lines[0]), JSON.stringify(lines[0]));
	check("python heredoc: body import keyword", lines[1].includes("\x1b[38;2;199;146;234mimport"), JSON.stringify(lines[1]));
	check("python heredoc: body comment gray", lines[2].includes("\x1b[38;2;84;110;122m# dump"), JSON.stringify(lines[2]));
	check("python heredoc: closing dark blue", lines[3] === `${DARK_BLUE}EOF${RESET}`, JSON.stringify(lines[3]));
}
{
	const seg = "node <<EOF\nconsole.log(\"x\")\nEOF";
	const out = colorizeCodeSegment(seg);
	check("node heredoc: round-trips", roundTrips(seg, out));
	check("node heredoc: body colored", out.includes("\x1b[38;2;130;170;255mlog"));
}
{
	const seg = "cat <<'EOF'\npython3 -c 'print(1)'\nEOF";
	const out = colorizeCodeSegment(seg);
	check("cat heredoc: stays flat dark blue", roundTrips(seg, out) && out.split("\n").every(flatDarkBlue), JSON.stringify(out));
}
{
	// unterminated heredoc — everything after the header is body
	const seg = "python3 <<EOF\nprint(1)";
	const out = colorizeCodeSegment(seg);
	check("unterminated heredoc: round-trips", roundTrips(seg, out));
	check("unterminated heredoc: body colored", out.includes("\x1b[38;2;199;146;234mprint"), JSON.stringify(out));
}
{
	const seg = "python3 - <<'EOF'\nx = 1\nprint(f\"v={x}\")\nEOF";
	const out = colorizeCodeSegment(seg);
	check("f-string heredoc: round-trips", roundTrips(seg, out));
	check("f-string heredoc: per-line discipline", perLineDiscipline(out));
}

// --- detection: heredoc redirected into a file (language from extension) -----
{
	// The exact shape from the field report: `cat >/tmp/e2e-load.ts <<'EOF'`
	const seg = `cat
        >/tmp/e2e-load.ts <<'EOF'
const mod = await import("./index.ts");
const tools: string[] = [];
registerTool: (t: any) => tools.push(t.name),
EOF`;
	const out = colorizeCodeSegment(seg);
	const lines = out.split("\n");
	check("ts file heredoc: round-trips", roundTrips(seg, out));
	check("ts file heredoc: per-line discipline", perLineDiscipline(out));
	check("ts file heredoc: header dark blue", stripAnsi(lines[1]) === "        >/tmp/e2e-load.ts <<'EOF'" && flatDarkBlue(lines[1]), JSON.stringify(lines[1]));
	check("ts file heredoc: body const keyword", out.includes("\x1b[38;2;199;146;234mconst"), JSON.stringify(lines[3]));
	check("ts file heredoc: body string green", out.includes("\x1b[38;2;195;232;141m\"./index.ts\""));
	check("ts file heredoc: closing dark blue", lines[lines.length - 1] === `${DARK_BLUE}EOF${RESET}`, JSON.stringify(lines[lines.length - 1]));
}
{
	const seg = "tee /tmp/out.py <<'EOF'\nx = [1, 2]\nprint(sum(x))\nEOF";
	const out = colorizeCodeSegment(seg);
	check("py file heredoc: round-trips", roundTrips(seg, out));
	check("py file heredoc: print colored", out.includes("\x1b[38;2;199;146;234mprint"), JSON.stringify(out));
}
{
	const seg = "cat > /tmp/data.json <<'EOF'\n{\n  \"k\": 1\n}\nEOF";
	const out = colorizeCodeSegment(seg);
	check("json file heredoc: round-trips", roundTrips(seg, out));
	check("json file heredoc: number colored", out.includes("\x1b[38;2;247;140;108m1"), JSON.stringify(out));
}
{
	const seg = "cat > notes.log <<'EOF'\njust text\nEOF";
	const out = colorizeCodeSegment(seg);
	check("unknown extension: flat dark blue", roundTrips(seg, out) && out.split("\n").every(flatDarkBlue), JSON.stringify(out));
}

// --- detection: shell heredocs / sh -c ---------------------------------------
{
	const seg = "bash <<'EOF'\necho \"hi\"  # greet\nEOF";
	const out = colorizeCodeSegment(seg);
	check("bash heredoc: round-trips", roundTrips(seg, out));
	check("bash heredoc: echo builtin blue", out.includes("\x1b[38;2;130;170;255mecho"), JSON.stringify(out));
	check("bash heredoc: comment gray", out.includes("\x1b[38;2;84;110;122m# greet"));
}
{
	const seg = "sh -c 'echo hi'";
	const out = colorizeCodeSegment(seg);
	check("sh -c: round-trips", roundTrips(seg, out));
	check("sh -c: colored", out !== `${DARK_BLUE}${seg}${RESET}`);
}

// --- multi-line string token spans a line boundary ----------------------------
{
	const code = 'x = """\nspanning\n"""\nprint(x)';
	const lines = colorizeCodeLines(code, "python");
	check("multiline string: line count", lines.length === code.split("\n").length);
	check("multiline string: per-line discipline", lines.every((l) => l === "" || perLineDiscipline(l)), JSON.stringify(lines));
}

// --- non-code segments: unchanged behavior ------------------------------------
{
	const seg = "python3 script.py --flag value";
	const out = colorizeCodeSegment(seg);
	check("script mode: flat dark blue", out === `${DARK_BLUE}${seg}${RESET}`, JSON.stringify(out));
	const wrapped = colorizeCodeSegment(seg, 20);
	check("script mode: wrapPath still applied", stripAnsi(wrapped) === wrapPath(seg, 20));
}
{
	const seg = "echo python3 -c 'x'";
	const out = colorizeCodeSegment(seg);
	check("echo python3: not code", out === `${DARK_BLUE}${seg}${RESET}`, JSON.stringify(out));
}
{
	const seg = "ls -la && cat foo";
	const out = colorizeCodeSegment(seg);
	check("plain command: flat dark blue", out === `${DARK_BLUE}${seg}${RESET}`, JSON.stringify(out));
}
{
	// bash -c IS code — colored as bash now that sh/bash are interpreters
	const seg = 'bash -c "python3 -c \'print(1)\'"';
	const out = colorizeCodeSegment(seg);
	check("nested bash -c: round-trips", roundTrips(seg, out), JSON.stringify(out));
	check("nested bash -c: colored as bash", out !== `${DARK_BLUE}${seg}${RESET}`);
	check("nested bash -c: string green", out.includes("\x1b[38;2;195;232;141m'"), JSON.stringify(out));
}
{
	const seg = "python3 -c";
	const out = colorizeCodeSegment(seg);
	check("dangling -c: flat", out === `${DARK_BLUE}${seg}${RESET}`, JSON.stringify(out));
}
{
	const seg = "python3 -c print(1)";
	const out = colorizeCodeSegment(seg);
	check("unquoted -c code: flat", out === `${DARK_BLUE}${seg}${RESET}`, JSON.stringify(out));
}
{
	const seg = "cat <<'EOF'\njust text\nEOF";
	const out = colorizeCodeSegment(seg);
	check("cat heredoc: flat (no interpreter)", roundTrips(seg, out) && out.split("\n").every(flatDarkBlue), JSON.stringify(out));
}

// --- kill switch ---------------------------------------------------------------
{
	process.env.PI_HASHLINE_CODE_COLOR = "1";
	const seg = "python3 -c 'print(1)'";
	const out = colorizeCodeSegment(seg);
	check("kill switch: flat dark blue", out === `${DARK_BLUE}${seg}${RESET}`, JSON.stringify(out));
	delete process.env.PI_HASHLINE_CODE_COLOR;
}

// --- malformed input fails soft ------------------------------------------------
{
	const seg = "python3 -c 'def =( broken"; // unterminated quote
	const out = colorizeCodeSegment(seg);
	check("unterminated quote: round-trips", roundTrips(seg, out), JSON.stringify(out));
	check("unterminated quote: flat dark blue", out === `${DARK_BLUE}${seg}${RESET}`, JSON.stringify(out));
}
{
	const seg = "python3 -c 'def =( broken'"; // broken but properly quoted
	const out = colorizeCodeSegment(seg);
	check("broken code: round-trips", roundTrips(seg, out), JSON.stringify(out));
	check("broken code: per-line discipline", perLineDiscipline(out));
	check("broken code: still colored", out !== `${DARK_BLUE}${seg}${RESET}`);
}

console.log(failures === 0 ? "\nall ok" : `\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
