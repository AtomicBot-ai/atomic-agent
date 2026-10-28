// ATO-1251 / ATO-664: a reply's markdown as the window's own blocks.
// md-render.js is loaded as a CommonJS module; renderProseFresh (the pass
// that adds links and file chips around it) is read from renderer.js as text
// and run in a vm context with its neighbours stubbed. No deps, no build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const { mdRender, mdTableText } = require("../renderer/md-render.js");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
/** renderMarkdown's output with the held code put back, as renderProseFresh ends up showing it. */
const md = (s) => { const o = mdRender(esc(s)); return o.html.replace(/\u0000(\d+)\u0000/g, (m, i) => o.held[+i]); };

test("plain prose is unchanged: lines and blank lines stay as they were", () => {
  assert.equal(md("Hello there.\n\nSecond paragraph,\nsame paragraph."), "Hello there.\n\nSecond paragraph,\nsame paragraph.");
  assert.equal(md("a **b** *c* ~~d~~"), "a <strong>b</strong> <em>c</em> <s>d</s>");
});

test("headings, rules and quotes keep their old tags", () => {
  assert.equal(md("# One"), '<h1 class="mdh">One</h1>');
  assert.equal(md("#### Four"), '<h4 class="mdh">Four</h4>');
  assert.equal(md("---"), '<hr class="mdhr">');
  assert.equal(md("> quoted\n> more"), '<blockquote class="mdquote">quoted\nmore</blockquote>');
});

test("a table gets its frame, Copy buttons and a numeric column on the right", () => {
  const h = md("| Name | Price |\n|:--|---|\n| Tea | 3,50 |\n| Cake | 12 |");
  assert.match(h, /^<div class="mdtblx">/);
  assert.match(h, /data-mdtcopy="tsv"/);
  assert.match(h, /data-mdtcopy="md"/);
  assert.match(h, /<th style="text-align:left">Name<\/th>/);
  assert.match(h, /<td class="mdnum">12<\/td>/);
  assert.equal(h.indexOf("\n"), -1, "one line of markup: the reply is pre-wrap");
});

test("a table's yes/no cells are marked", () => {
  const h = md("| | A | B |\n|---|---|---|\n| Offline | ✅ | ❌ |");
  assert.match(h, /<td class="mdyes">✅<\/td>/);
  assert.match(h, /<td class="mdno">❌<\/td>/);
});

test("mdTableText copies as TSV and as markdown with the header's alignment", () => {
  const rows = [["a", "b|c"], ["1", "two\twords"]];
  assert.equal(mdTableText(rows, ["", "right"], "tsv"), "a\tb|c\n1\ttwo words");
  assert.equal(mdTableText(rows, ["", "right"], "md"), "| a | b\\|c |\n| --- | ---: |\n| 1 | two words |");
});

test("checklists, nested items and a loose numbered list that keeps counting", () => {
  const h = md("- [x] done\n- [ ] todo\n  - nested\n\n3. c\n\n4. d");
  assert.match(h, /<ul class="mdlist mdtasks"><li class="mdtask done"><span class="mdchk" aria-hidden="true">✓<\/span>/);
  assert.match(h, /<li class="mdtask">.*<ul class="mdlist"><li>nested<\/li><\/ul><\/li>/);
  assert.match(h, /<ol class="mdlist" start="3"><li>c<\/li><li>d<\/li><\/ol>/);
});

test("CRLF replies and tab-indented nesting render as lists", () => {
  assert.equal(md("- a\r\n- b"), '<ul class="mdlist"><li>a</li><li>b</li></ul>');
  assert.match(md("> [!NOTE]\r\n> hi"), /mdc-note/);
  assert.equal(md("- a\n\t- nested\n- b"), '<ul class="mdlist"><li>a<ul class="mdlist"><li>nested</li></ul></li><li>b</li></ul>');
});

test("numbered items that lead with a bold name are steps", () => {
  assert.match(md("1. **Install** it\n2. **Run** it"), /^<ol class="mdlist mdsteps">/);
  assert.match(md("1. Install it\n2. **Run** it"), /^<ol class="mdlist">/);
});

test("lines of **Key:** value are fields, bulleted or not", () => {
  const want = '<dl class="mdkv"><div class="mdkv-r"><dt>Name</dt><dd>Bob</dd></div><div class="mdkv-r"><dt>Age</dt><dd>3</dd></div></dl>';
  assert.equal(md("**Name:** Bob\n**Age:** 3"), want);
  assert.equal(md("- **Name**: Bob\n- **Age**: 3"), want);
  // one line alone is just prose
  assert.equal(md("**Name:** Bob"), "<strong>Name:</strong> Bob");
});

test("callouts: GitHub's [!NOTE], a bold lead, an emoji lead", () => {
  assert.match(md("> [!WARNING]\n> careful"), /^<div class="mdcallout mdc-warning" role="note"><div class="mdcallout-t">Warning<\/div><div class="mdcallout-b">careful<\/div><\/div>$/);
  assert.match(md("**Tip:** use it\nmore"), /^<div class="mdcallout mdc-tip".*>use it\nmore<\/div><\/div>$/);
  assert.match(md("⚠️ Do not unplug"), /^<div class="mdcallout mdc-warning"/);
  assert.match(md("Важно: не трогать"), /mdc-important.*>Важно</);
  // a bold word that is not a callout's name stays prose
  assert.equal(md("**Summary:** all good"), "<strong>Summary:</strong> all good");
});

test("Pros and Cons lists become one comparison", () => {
  const h = md("**Pros:**\n- fast\n- cheap\n\n**Cons:**\n- loud");
  assert.match(h, /^<div class="mdcmp"><div class="mdcmp-c pro"><div class="mdcmp-t">Pros<\/div><ul class="mdlist"><li>fast<\/li><li>cheap<\/li><\/ul><\/div><div class="mdcmp-c con">/);
  // a Pros heading with no Cons is a heading and a list
  assert.equal(md("## Pros\n- a"), '<h2 class="mdh">Pros</h2>\n<ul class="mdlist"><li>a</li></ul>');
});

test("links: http(s) only, alone on a line a card", () => {
  assert.match(md("see [docs](https://ex.com/a?b=1&c=2) now"), /see <a class="msglink" href="#" data-url="https:\/\/ex.com\/a\?b=1&amp;c=2">docs<\/a> now/);
  assert.match(md("[Docs](https://ex.com)"), /^<a class="msglink mdcard" href="#" data-url="https:\/\/ex.com">.*<span class="mdcard-h">ex.com<\/span>/);
  assert.match(md("https://www.ex.com/p"), /mdcard.*>ex.com\/p</);
});

test("XSS: nothing a model writes becomes markup or a script link", () => {
  for (const s of [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "[x](javascript:alert(1))",
    "[x](javascript:void)",
    "[x](JaVaScRiPt:alert`1`)",
    "[x](data:text/html,<b>)",
    '[x](https://a.com" onmouseover="alert(1))',
    "[x](vbscript:msgbox)",
    "| a | b |\n|---|---|\n| <b>x</b> | [y](javascript:z) |",
    "> [!NOTE]\n> <iframe src=x>",
  ]) {
    const h = md(s);
    assert.doesNotMatch(h, /<(?:script|img|iframe|b)[\s>]/i, s);
    assert.doesNotMatch(h, /data-url="(?!https?:\/\/)/i, s);
    assert.doesNotMatch(h, /\son\w+="/i, s);
  }
});

test("a local link target is left for the file-chip pass", () => {
  assert.equal(md("open [the report](~/Desktop/r.md)"), "open the report (~/Desktop/r.md)");
  assert.equal(md("see [~/a.md](file://~/a.md)"), "see ~/a.md");
});

test("a path alone on its line is wrapped for the file card", () => {
  assert.equal(md("`~/Desktop/report.md`"), '<span class="mdsolo"><code class="mdcode">~/Desktop/report.md</code></span>');
  assert.equal(md("/Users/me/notes.txt"), '<span class="mdsolo">/Users/me/notes.txt</span>');
  assert.equal(md("see /Users/me/notes.txt"), "see /Users/me/notes.txt");
});

test("streaming: an open fence is already a code block, and the closed one is the same block", () => {
  const open = md("Here:\n```py\nprint(1)\n");
  assert.match(open, /<pre class="mdpre" data-open="1" data-lang="py"><code>print\(1\)\n<\/code><\/pre>/);
  const closed = md("Here:\n```py\nprint(1)\n```");
  assert.match(closed, /<pre class="mdpre" data-lang="py"><code>print\(1\)\n<\/code><\/pre>/);
  // markdown inside code is not markdown
  assert.match(md("```\n**not bold** | a |\n|---|\n```"), /<code>\*\*not bold\*\* \| a \|\n\|---\|\n<\/code>/);
});

test("every prefix of a rich reply renders without throwing (a stream's frames)", () => {
  const reply = "# Plan\n\n> [!TIP]\n> start small\n\n1. **One** — first\n2. **Two** — second\n\n| a | b |\n|---|--:|\n| x | 1 |\n\n**Pros:**\n- a\n\n**Cons:**\n- b\n\n```js\nlet x = 1;\n```\n\n- [ ] done?\n\nhttps://example.com";
  for (let n = 0; n <= reply.length; n++) assert.equal(typeof md(reply.slice(0, n)), "string");
});

test("a long reply is rendered in reasonable time", () => {
  const big = Array.from({ length: 4000 }, (_, i) => (i % 7 === 0 ? "- item **" + i + "**" : i % 11 === 0 ? "| a | b |\n|---|---|\n| 1 | 2 |" : "line " + i + " with `code` and [l](https://e.com/" + i + ")")).join("\n");
  const t0 = Date.now();
  md(big);
  assert.ok(Date.now() - t0 < 1500, "took " + (Date.now() - t0) + "ms");
});

// The pass around it: renderProseFresh in renderer.js, with its neighbours stubbed.
const source = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
function fn(name) {
  const at = source.indexOf("\nfunction " + name + "(");
  assert.ok(at >= 0, name + " is a top-level function in renderer.js");
  return source.slice(at + 1, source.indexOf("\n}\n", at) + 2);
}
function prose() {
  const c = vm.createContext({});
  vm.runInContext(readFileSync(new URL("../renderer/md-render.js", import.meta.url), "utf8")
    + "\nconst IS_WIN = false;\nconst esc = " + esc.toString() + ";\n"
    + "function ic() { return ''; }\n"
    + "function replyPathChip(raw, shown) { return '<button class=\"filechip\" data-file=\"' + esc(raw) + '\">' + esc(raw) + '</button>'; }\n"
    + fn("renderMarkdown") + fn("renderProseFresh") + fn("codeBlockFrame") + fn("codeSpanIsPath")
    + "globalThis.renderProseFresh = renderProseFresh;", c);
  return c.renderProseFresh;
}

test("renderProseFresh: a card's URL is not wrapped twice, a bare URL is still a link, a path still a chip", () => {
  const render = prose();
  const card = render("[Docs](https://ex.com/a)");
  assert.equal((card.match(/<a /g) || []).length, 1, card);
  const bare = render("see https://ex.com/b and ~/notes/a.md");
  assert.match(bare, /<a class="msglink" href="#" data-url="https:\/\/ex.com\/b">/);
  assert.match(bare, /<button class="filechip" data-file="~\/notes\/a.md">/);
  const solo = render("`~/Desktop/report.md`");
  assert.match(solo, /^<span class="mdsolo"><button class="filechip"/);
  const tbl = render("| a | b |\n|---|---|\n| https://ex.com | ~/x.md |");
  assert.match(tbl, /<td><a class="msglink"[^>]*>https:\/\/ex.com<\/a><\/td>/);
  assert.match(tbl, /<td><button class="filechip"/);
});
