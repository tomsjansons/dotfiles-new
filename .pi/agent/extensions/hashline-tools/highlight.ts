/**
 * Syntax coloring for bash tool segments that carry python or node code.
 *
 * The bash renderer paints every command segment in flat DARK_BLUE. Segments
 * that embed code — `python3 -c '…'`, `node --eval "…"`, `python3 <<'EOF'`
 * heredocs — get token-level Material-syntax coloring instead (see render.ts
 * CODE_* constants).
 *
 * Pipeline per segment:
 *
 *   colorizeCodeSegment(segment)
 *     ├─ contains `<<`  → colorizeHeredocTail()   (body tokenized as code,
 *     │                            header/closing line stay dark blue)
 *     ├─ inline code    → interpreter token + code flag (-c/--eval/-e/-p)
 *     │                    followed by a quoted token → colorize the quoted
 *     │                    inner text, quote chars and surroundings stay dark
 *     └─ otherwise      → flat dark blue (wrapPath when a width is given)
 *
 * Heredoc language comes from the interpreter word (`python3 - <<EOF`), or —
 * when the body is redirected into a file (`cat >/tmp/e2e-load.ts <<'EOF'`,
 * `tee out.py <<EOF`) — from the target file's extension in the heredoc
 * header line.
 *
 * Tokenization is PrismJS (regex tokenizer, sync — render passes re-run
 * constantly, so no async grammar loading). Tokens are flattened to
 * { text, color } leaves, split at newlines, and emitted per line with a
 * foreground reset at each EOL — the same discipline as colorizeLines() so
 * RawText's per-line truncation stays byte-faithful and color can't leak
 * between lines.
 *
 * Fails soft: any detection miss or tokenize throw falls back to plain dark
 * blue. Kill switch: PI_HASHLINE_CODE_COLOR (any value) disables coloring.
 */

import Prism from "prismjs";
import "prismjs/components/prism-markup";
import "prismjs/components/prism-clike";
import "prismjs/components/prism-css";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-python";
import "prismjs/components/prism-json";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-markdown";
import {
	ANSI_RESET_FG,
	CODE_COMMENT,
	CODE_FUNCTION,
	CODE_KEYWORD,
	CODE_NUMBER,
	CODE_OPERATOR,
	CODE_STRING,
	CODE_TYPE,
	colorizeCommand,
	DARK_BLUE,
	wrapPath,
} from "./render";

export type CodeLang = "python" | "javascript" | "typescript" | "tsx" | "jsx" | "json" | "bash" | "yaml" | "markdown" | "css" | "markup";

/** Interpreter word → language. Matched against whole unquoted tokens. */
const PYTHON_RE = /^(?:python3?(?:\.\d{1,2})?|pypy3?)$/i;
const NODE_RE = /^(?:node|nodejs|bun)$/i;
const SHELL_RE = /^(?:sh|bash|zsh|dash)$/i;

/** File extension (lowercase, no dot) → language for redirected heredocs. */
const EXT_LANG: Record<string, CodeLang> = {
	ts: "typescript",
	mts: "typescript",
	cts: "typescript",
	tsx: "tsx",
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	jsx: "jsx",
	py: "python",
	pyw: "python",
	json: "json",
	jsonc: "json",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	dash: "bash",
	yaml: "yaml",
	yml: "yaml",
	md: "markdown",
	markdown: "markdown",
	css: "css",
	html: "markup",
	htm: "markup",
	xml: "markup",
	svg: "markup",
};

/**
 * Words that may precede the interpreter without disqualifying the segment
 * (`env FOO=1 python3 …`, `sudo python3 …`, `timeout 10 python3 …`).
 */
const INTERPRETER_SKIP = new Set(["env", "sudo", "nohup", "nice", "time", "timeout", "exec", "stdbuf", "watch"]);
const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const FLAG_RE = /^-{1,2}[A-Za-z][\w.-]*/;

/** Prism token types that keep the surrounding (parent) color when nested. */
const INHERIT_INSIDE = new Set(["punctuation", "interpolation", "template-punctuation"]);

/** Prism token type/alias → Material palette color. */
const TOKEN_COLORS: Record<string, string> = {
	comment: CODE_COMMENT,
	string: CODE_STRING,
	"triple-quoted-string": CODE_STRING,
	"template-string": CODE_STRING,
	"string-interpolation": CODE_STRING,
	char: CODE_STRING,
	regex: CODE_STRING,
	"attr-value": CODE_STRING,
	keyword: CODE_KEYWORD,
	"keyword-control": CODE_KEYWORD,
	tag: CODE_KEYWORD,
	"attr-name": CODE_KEYWORD,
	function: CODE_FUNCTION,
	builtin: CODE_FUNCTION,
	method: CODE_FUNCTION,
	selector: CODE_FUNCTION,
	url: CODE_FUNCTION,
	atrule: CODE_FUNCTION,
	boolean: CODE_NUMBER,
	number: CODE_NUMBER,
	constant: CODE_NUMBER,
	"class-name": CODE_TYPE,
	decorator: CODE_TYPE,
	type: CODE_TYPE,
	title: CODE_TYPE,
	operator: CODE_OPERATOR,
	punctuation: CODE_OPERATOR,
	delimiter: CODE_OPERATOR,
	property: CODE_OPERATOR,
};

/**
 * Shell token within a single (already operator-split) command segment.
 * `quote` is the quote character for quoted tokens ('…' / "…"), null for
 * unquoted runs. `raw`/`start`/`end` are the byte-faithful span including
 * the quote characters.
 */
interface ShellToken {
	raw: string;
	start: number;
	end: number;
	quote: "'" | '"' | null;
}

/**
 * Tokenize a command segment into whitespace-separated shell words, honoring
 * single quotes (no escapes), double quotes (backslash escapes) and backslash
 * escapes in unquoted runs. Deliberately NOT a full shell parser — operators,
 * `$()` etc. are just characters inside tokens; only quoting matters here.
 */
function tokenizeSegment(seg: string): ShellToken[] {
	const toks: ShellToken[] = [];
	let i = 0;
	while (i < seg.length) {
		if (/\s/.test(seg[i])) {
			i++;
			continue;
		}
		const start = i;
		const ch = seg[i];
		if (ch === "'") {
			const close = seg.indexOf("'", i + 1);
			if (close === -1) {
				// Unterminated quote (malformed shell) — unquoted run to the end;
				// quote: null keeps it out of inline-code coloring (fails soft).
				toks.push({ raw: seg.slice(start), start, end: seg.length, quote: null });
				i = seg.length;
				continue;
			}
			const end = close + 1;
			toks.push({ raw: seg.slice(start, end), start, end, quote: "'" });
			i = end;
			continue;
		}
		if (ch === '"') {
			let j = i + 1;
			let closed = false;
			while (j < seg.length) {
				if (seg[j] === "\\") {
					j += 2;
					continue;
				}
				if (seg[j] === '"') {
					closed = true;
					break;
				}
				j++;
			}
			if (!closed) {
				toks.push({ raw: seg.slice(start), start, end: seg.length, quote: null });
				i = seg.length;
				continue;
			}
			const end = j + 1;
			toks.push({ raw: seg.slice(start, end), start, end, quote: '"' });
			i = end;
			continue;
		}
		let j = i;
		while (j < seg.length && !/\s/.test(seg[j]) && seg[j] !== "'" && seg[j] !== '"') {
			if (seg[j] === "\\") j++; // skip the escaped char
			j++;
		}
		toks.push({ raw: seg.slice(start, j), start, end: j, quote: null });
		i = j;
	}
	return toks;
}

/**
 * Find the interpreter token: the first word that isn't an env-style
 * assignment, a known prefix word (sudo/env/…), a flag, or a bare number
 * (timeout's value). If that word isn't a known interpreter the segment is
 * not code (`echo python3`, `which python3` → null).
 */
function detectInterpreter(toks: ShellToken[]): { idx: number; lang: CodeLang } | null {
	for (let i = 0; i < toks.length; i++) {
		const raw = toks[i].raw;
		if (ASSIGN_RE.test(raw) || INTERPRETER_SKIP.has(raw) || FLAG_RE.test(raw) || /^\d+$/.test(raw)) continue;
		if (PYTHON_RE.test(raw)) return { idx: i, lang: "python" };
		if (NODE_RE.test(raw)) return { idx: i, lang: "javascript" };
		if (SHELL_RE.test(raw)) return { idx: i, lang: "bash" };
		return null;
	}
	return null;
}

/**
 * Find the quoted token holding inline code: scan tokens after the
 * interpreter; flags that aren't the code flag are skipped (-u, -B,
 * --input-type=module, …); the first positional word before a code flag
 * means script mode (null). Python code flag: `-c`. Node: -e/-p/--eval/
 * --print and the combined -pe/-ep, including `--eval=`/`--print=` attached
 * forms (the value then appears as the next, quoted token).
 */
function findCodeToken(toks: ShellToken[], from: number, lang: CodeLang): ShellToken | null {
	const isCodeFlag = (raw: string): boolean => {
		if (lang === "python" || lang === "bash") return raw === "-c";
		return /^-[ep]{1,2}$/.test(raw) || raw === "--eval" || raw === "--print" || /^--(?:eval|print)=$/.test(raw);
	};
	for (let i = from + 1; i < toks.length; i++) {
		const raw = toks[i].raw;
		if (!raw.startsWith("-")) return null; // positional arg (script path) before any code flag
		if (!isCodeFlag(raw)) continue;
		const next = toks[i + 1];
		return next && next.quote !== null ? next : null; // unquoted/missing code → don't color
	}
	return null;
}

/** Flat colored leaf — `color` applies to exactly `text` (no newlines after splitting). */
interface StyledSpan {
	text: string;
	color: string;
}

/** Resolve a Prism token's color: direct palette map, else the inherited (parent) color. */
function tokenColor(tok: Prism.Token, inherited: string | undefined): string {
	const aliases = typeof tok.alias === "string" ? [tok.alias] : (tok.alias ?? []);
	for (const name of [tok.type, ...aliases]) {
		if (inherited && INHERIT_INSIDE.has(name)) return inherited;
		const mapped = TOKEN_COLORS[name];
		if (mapped) return mapped;
	}
	return inherited ?? DARK_BLUE;
}

/** Flatten Prism's (possibly nested) token tree into colored leaves. */
function flattenTokens(tokens: (string | Prism.Token)[], inherited: string | undefined, out: StyledSpan[]): void {
	for (const tok of tokens) {
		if (typeof tok === "string") {
			out.push({ text: tok, color: inherited ?? DARK_BLUE });
			continue;
		}
		const color = tokenColor(tok, inherited);
		if (typeof tok.content === "string") out.push({ text: tok.content, color });
		else flattenTokens(tok.content as (string | Prism.Token)[], color, out);
	}
}

/** Memoized highlight results keyed by `${lang}\u0000${code}` (render passes re-run often). */
const lineCache = new Map<string, string[]>();
const LINE_CACHE_MAX = 400;

function grammarFor(lang: CodeLang): Prism.Grammar | undefined {
	return (Prism.languages as Record<string, Prism.Grammar | undefined>)[lang];
}

/**
 * Tokenize `code` as `lang` and emit one ANSI-colored string per line, with a
 * foreground reset at every EOL (color can't leak between lines and RawText's
 * per-line truncation stays byte-faithful). Line count always equals
 * code.split("\n").length. Falls back to flat dark blue on any error.
 */
export function colorizeCodeLines(code: string, lang: CodeLang): string[] {
	const plain = (): string[] => code.split("\n").map((line) => `${DARK_BLUE}${line}${ANSI_RESET_FG}`);
	if (!code) return [];
	const cacheKey = `${lang}\u0000${code}`;
	const cached = lineCache.get(cacheKey);
	if (cached) return cached;
	const grammar = grammarFor(lang);
	if (!grammar) return plain();
	let lines: string[];
	try {
		const spans: StyledSpan[] = [];
		flattenTokens(Prism.tokenize(code, grammar), undefined, spans);
		lines = [];
		let current = "";
		for (const span of spans) {
			const parts = span.text.split("\n");
			for (let i = 0; i < parts.length; i++) {
				if (i > 0) {
					lines.push(current);
					current = "";
				}
				if (parts[i]) current += `${span.color}${parts[i]}${ANSI_RESET_FG}`;
			}
		}
		lines.push(current);
	} catch {
		lines = plain();
	}
	if (lineCache.size >= LINE_CACHE_MAX) {
		const eldest = lineCache.keys().next().value;
		if (eldest !== undefined) lineCache.delete(eldest);
	}
	lineCache.set(cacheKey, lines);
	return lines;
}

/**
 * Detect the interpreter language in `head` (the command text before a
 * heredoc operator, or the whole segment for inline detection).
 */
function detectLang(head: string): CodeLang | null {
	const interp = detectInterpreter(tokenizeSegment(head));
	return interp?.lang ?? null;
}

/**
 * Detect a language from a file name appearing in `text` (the heredoc header
 * line): the last `.<ext>` token whose extension maps to a known language.
 * This colors redirected heredocs (`cat >/tmp/e.ts <<'EOF'`, `tee out.py <<EOF`)
 * whose head has no interpreter word.
 */
function detectLangFromFilename(text: string): CodeLang | null {
	for (const tok of tokenizeSegment(text)) {
		const name = tok.quote ? tok.raw.slice(1, -1) : tok.raw;
		const m = /\.([A-Za-z][A-Za-z0-9]*)$/.exec(name);
		if (m) {
			const lang = EXT_LANG[m[1].toLowerCase()];
			if (lang) return lang;
		}
	}
	return null;
}

/**
 * Colorize a heredoc tail — text starting at the `<<` operator (as produced
 * verbatim by splitShellCommand). The header line (`<<'EOF'`) and the closing
 * delimiter stay dark blue; body lines are tokenized as `lang` (detected from
 * `head`, e.g. `python3 - <<EOF`). Mirrors splitShellCommand's heredoc
 * parsing (delimiter quoting, `<<-` tab stripping, unterminated bodies).
 * Returns the text dark blue when it isn't a colorable heredoc.
 */
function colorizeHeredocTail(heredoc: string, head: string): string {
	const fallback = (): string => colorizeCommand(heredoc);
	if (heredoc[2] === "<") return fallback(); // here-string `<<<` — not code

	// Parse `<<[-][q]delim[q]` (delimiter ends at whitespace/operator).
	let j = 2;
	const dash = heredoc[j] === "-";
	if (dash) j++;
	while (j < heredoc.length && (heredoc[j] === " " || heredoc[j] === "\t")) j++;
	let delim = "";
	let quote: "'" | '"' | null = null;
	if (heredoc[j] === "'" || heredoc[j] === '"') {
		quote = heredoc[j] as "'" | '"';
		j++;
	}
	while (j < heredoc.length) {
		const ch = heredoc[j];
		if (quote) {
			if (ch === quote) {
				j++;
				break;
			}
			delim += ch;
		} else if (/[\s|&;<>()`"']/.test(ch)) {
			break;
		} else {
			delim += ch;
		}
		j++;
	}
	const headerEnd = heredoc.indexOf("\n", j);
	if (!delim || headerEnd === -1) return fallback(); // no body → nothing to color

	// Interpreter word wins (`python3 - <<EOF`); otherwise the heredoc may be
	// redirected into a file (`cat >/tmp/e.ts <<'EOF'`) — infer from the
	// target's extension anywhere in the header line.
	const lang = detectLang(head) ?? detectLangFromFilename(`${head} ${heredoc.slice(0, headerEnd)}`);
	if (!lang) return fallback();

	const header = heredoc.slice(0, headerEnd + 1);
	const lines = heredoc.slice(headerEnd + 1).split("\n");
	let closeIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = dash ? lines[i].replace(/^\t+/, "") : lines[i];
		if (line === delim) {
			closeIdx = i;
			break;
		}
	}
	if (closeIdx === -1) {
		// Unterminated heredoc — everything after the header is body.
		return [colorizeCommand(header.replace(/\n$/, "")), ...colorizeCodeLines(lines.join("\n"), lang)].join("\n");
	}
	const body = lines.slice(0, closeIdx).join("\n");
	const coloredBody = body ? colorizeCodeLines(body, lang) : [];
	const closing = colorizeCommand(lines.slice(closeIdx).join("\n"));
	return [colorizeCommand(header.replace(/\n$/, "")), ...coloredBody, closing].join("\n");
}

/**
 * Colorize a segment carrying inline code (`python3 -c '…'`,
 * `node --eval "…"`): everything before/after the quoted code token stays
 * dark blue, the quote characters stay dark blue, the quoted inner text is
 * tokenized as the interpreter's language. Returns null when the segment
 * isn't inline code (caller falls back).
 */
function colorizeInlineSegment(segment: string): string | null {
	const toks = tokenizeSegment(segment);
	const interp = detectInterpreter(toks);
	if (!interp) return null;
	const codeTok = findCodeToken(toks, interp.idx, interp.lang);
	if (!codeTok || codeTok.quote === null) return null;
	const inner = segment.slice(codeTok.start + 1, codeTok.end - 1);
	if (!inner) return null;
	const before = segment.slice(0, codeTok.start);
	const after = segment.slice(codeTok.end);
	const q = colorizeCommand(codeTok.quote);
	return (
		colorizeCommand(before) +
		q +
		colorizeCodeLines(inner, interp.lang).join("\n") +
		q +
		colorizeCommand(after)
	);
}

/**
 * Colorize one bash command segment: python/node code (inline or heredoc) is
 * syntax-colored with the Material palette; everything else stays flat dark
 * blue (width-wrapped when `wrapWidth` is given, matching the previous
 * single-color behavior). Colored code is byte-faithful — never re-wrapped —
 * so long lines are simply width-truncated by RawText at render time.
 *
 * Kill switch: PI_HASHLINE_CODE_COLOR disables all code coloring.
 */
export function colorizeCodeSegment(segment: string, wrapWidth?: number): string {
	const fallback = (): string =>
		colorizeCommand(wrapWidth !== undefined ? wrapPath(segment, wrapWidth) : segment);
	if (process.env.PI_HASHLINE_CODE_COLOR) return fallback();

	const hdIdx = segment.indexOf("<<");
	if (hdIdx !== -1) {
		const head = segment.slice(0, hdIdx);
		// colorizeHeredocTail falls back to dark blue internally when the
		// heredoc isn't colorable (no interpreter, here-string, no body).
		const headText = wrapWidth !== undefined ? wrapPath(head, wrapWidth) : head;
		return colorizeCommand(headText) + colorizeHeredocTail(segment.slice(hdIdx), head);
	}
	return colorizeInlineSegment(segment) ?? fallback();
}
