// ATO-1140: formulas (KaTeX) and Mermaid diagrams in a reply (renderer/rich-blocks.js).
// The detector runs through the real markdown pipeline (vendored marked +
// md-render.js); the drawing step runs on a small fake tree with the libraries
// mocked, so no KaTeX or Mermaid is needed here and nothing is fetched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
vm.runInThisContext(readFileSync(new URL("../renderer/vendor/marked.js", import.meta.url), "utf8"));
const RB = require("../renderer/rich-blocks.js");
// In the window these are globals of their script; md-render.js looks them up the same way.
Object.assign(globalThis, RB);
const { mdRender } = require("../renderer/md-render.js");
const md = (s) => { const o = mdRender(s); return o.html.replace(/\u0000(\d+)\u0000/g, (m, i) => o.held[+i]); };
const kinds = (s) => [...md(s).matchAll(/data-rb-kind="(\w+)"/g)].map((m) => m[1]);
const texOf = (s) => [...md(s).matchAll(/data-rb-tex="([^"]*)"/g)].map((m) => m[1]);

/* ---------------- detector ---------------- */

test("inline and display formulas are found", () => {
  assert.deepEqual(texOf("Area is $\\pi r^2$ here."), ["\\pi r^2"]);
  assert.deepEqual(texOf("One letter $x$ too."), ["x"]);
  assert.deepEqual(texOf("Inline \\(a+b\\) works."), ["a+b"]);
  assert.deepEqual(texOf("Sum: $$\\sum_{i=1}^n i$$ done"), ["\\sum_{i=1}^n i"]);
  assert.match(md("$$\nE = mc^2\n$$"), /class="rb-math rb-display"/);
  assert.deepEqual(texOf("Before\n\n\\[\na^2 + b^2 = c^2\n\\]\n\nAfter"), ["a^2 + b^2 = c^2"]);
  assert.deepEqual(texOf("Text right before\n$$x_1 * y_2$$"), ["x_1 * y_2"], "a display block interrupts a paragraph");
});

test("markdown inside a formula is left alone", () => {
  assert.deepEqual(texOf("$a_1 * b_2 * c_3$"), ["a_1 * b_2 * c_3"]);
  assert.doesNotMatch(md("$a_1 * b_2 * c_3$"), /<em>/);
});

test("prices and other dollars stay text", () => {
  for (const s of [
    "It costs $5 and $10 later.",
    "Between $5-$10 per seat.",
    "$5,$10,$15",
    "Pay $ 5 now and $ 6 later.",
    "Set $PATH and $HOME first.",
    "US$5 or US$6",
    "From $20k to $30k a year.",
    "Escaped \\$5 and \\$6 stay dollars.",
    "A lone $ sign.",
    "Two lines $a\nb$ are not one formula.",
  ]) assert.deepEqual(kinds(s), [], s);
});

test("a dollar in code is never a formula", () => {
  assert.deepEqual(kinds("Run `echo $HOME$` then."), []);
  assert.deepEqual(kinds("```sh\necho $x$ $$y$$\n```"), []);
});

test("rbMathAt follows Pandoc's rules at the start of the text", () => {
  assert.deepEqual(RB.rbMathAt("$x$ rest"), { raw: "$x$", tex: "x", display: false });
  assert.equal(RB.rbMathAt("$ x$"), null, "space after the opening $");
  assert.equal(RB.rbMathAt("$x $"), null, "space before the closing $");
  assert.equal(RB.rbMathAt("$x$1"), null, "closing $ followed by a digit");
  assert.equal(RB.rbMathAt("$x$y"), null, "closing $ followed by a letter");
  assert.equal(RB.rbMathAt("$$ $$"), null, "an empty display formula");
});

test("the formula's source is escaped in the placeholder", () => {
  const h = md('$a<b$ and $\\text{"q"}$');
  assert.match(h, /data-rb-tex="a&lt;b"/);
  assert.match(h, /data-rb-tex="\\text\{&quot;q&quot;\}"/);
  assert.doesNotMatch(h, /<b\$/);
});

test("a closed mermaid fence is a diagram block; an open one is still code", () => {
  const closed = md("```mermaid\ngraph TD\n  A-->B\n```");
  assert.deepEqual(kinds("```mermaid\ngraph TD\n  A-->B\n```"), ["mermaid"]);
  assert.match(closed, /class="mdblock rb-mermaid"/);
  assert.match(closed, /data-mdcopy/, "Copy still copies the source");
  assert.match(closed, /<pre class="mdpre" data-lang="mermaid"><code>graph TD\n  A--&gt;B\n<\/code><\/pre>/);
  const open = md("```mermaid\ngraph TD\n  A-->");
  assert.deepEqual(kinds("```mermaid\ngraph TD\n  A-->"), [], "still streaming");
  assert.match(open, /data-open="1"/);
  assert.deepEqual(kinds("```js\nconst a = 1;\n```"), []);
});

test("the same source keeps the same morph key, another source gets another", () => {
  const key = (s) => (/data-morph-keep="([^"]+)"/.exec(md(s)) || [])[1];
  assert.equal(key("$x^2$"), key("so $x^2$ again"));
  assert.notEqual(key("$x^2$"), key("$x^3$"));
  assert.equal(key("```mermaid\ngraph TD\nA-->B\n```"), key("```mermaid\ngraph TD\nA-->B\n```\nmore text"));
});

test("index.html loads rich-blocks.js after md-render.js and before renderer.js, and not the libraries", () => {
  const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
  const at = (s) => html.indexOf(s);
  assert.ok(at('src="md-render.js"') > 0 && at('src="md-render.js"') < at('src="rich-blocks.js"'));
  assert.ok(at('src="rich-blocks.js"') < at('src="renderer.js"'));
  assert.equal(at("vendor/katex"), -1, "KaTeX is loaded on first use, not at start");
  assert.equal(at("vendor/mermaid"), -1, "Mermaid is loaded on first use, not at start");
  assert.match(html, /script-src 'self'/);
  assert.match(html, /connect-src 'none'/);
});

test("renderer.js draws after both transcript paints", () => {
  const src = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
  assert.equal(src.split("richBlocksHydrate(").length - 1, 2);
});

/* ---------------- drawing (libraries mocked) ---------------- */

class El {
  constructor(attrs, kids) { this.attrs = new Map(Object.entries(attrs)); this.kids = kids || {}; this.innerHTML = ""; this.hidden = false; this.isConnected = true; }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  querySelector(sel) { return this.kids[sel] || null; }
}
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** The placeholders of a rendered reply as a tree root, the way querySelectorAll('[data-rb-kind]') sees them. */
function rootOf(text) {
  const html = md(text);
  const els = [];
  for (const m of html.matchAll(/<(?:span|div) class="[^"]*" data-rb-kind="(\w+)"[^>]*>/g)) {
    const attrs = {};
    for (const a of m[0].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = unesc(a[2]);
    if (m[1] === "mermaid") {
      const code = { textContent: unesc((/<code>([\s\S]*?)<\/code>/.exec(html.slice(m.index)) || [])[1] || "") };
      const pre = { hidden: false };
      els.push(new El(attrs, { ".rb-diagram": { innerHTML: "", hidden: true }, pre, "pre code": code }));
    } else els.push(new El(attrs));
  }
  return { els, querySelectorAll: (sel) => (sel === "[data-rb-kind]" ? els : []) };
}
async function until(cond, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const calls = { katex: 0, mermaid: 0, render: 0 };
globalThis.DOMPurify = { sanitize: (h) => h };
globalThis.document = { documentElement: { getAttribute: () => "light" }, getElementById: () => null };
RB.RB_LOADERS.katex = () => { calls.katex++; return Promise.resolve({ renderToString: (tex, o) => '<span class="katex">' + (o.displayMode ? "D:" : "") + tex + "</span>" }); };
RB.RB_LOADERS.mermaid = () => {
  calls.mermaid++;
  return Promise.resolve({
    initialize() {},
    parse: async () => true,
    render: async (id, src) => { calls.render++; return { svg: '<svg id="' + id + '"><text>' + src.length + "</text></svg>" }; },
  });
};

test("a reply with no formula or diagram never asks for a library", async () => {
  for (const s of ["Plain text.", "It costs $5 and $10.", "```js\nlet $a = 1;\n```", "| a | b |\n|---|---|\n| $5 | $6 |"]) {
    const found = RB.richBlocksHydrate(rootOf(s));
    assert.deepEqual(found, { math: 0, mermaid: 0 }, s);
  }
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.katex, 0);
  assert.equal(calls.mermaid, 0);
});

test("a formula loads KaTeX once and is drawn in place", async () => {
  const root = rootOf("Area $\\pi r^2$ and $$E=mc^2$$.");
  assert.deepEqual(RB.richBlocksHydrate(root), { math: 2, mermaid: 0 });
  // A second frame while KaTeX is still loading does not queue the same formulas again.
  assert.deepEqual(RB.richBlocksHydrate(root), { math: 0, mermaid: 0 });
  await until(() => root.els.every((e) => e.getAttribute("data-rb-done") === "1"));
  assert.equal(root.els[0].innerHTML, '<span class="katex">\\pi r^2</span>');
  assert.equal(root.els[1].innerHTML, '<span class="katex">D:E=mc^2</span>');
  const again = rootOf("New reply $x$.");
  RB.richBlocksHydrate(again);
  await until(() => again.els[0].getAttribute("data-rb-done") === "1");
  assert.equal(calls.katex, 1, "one shared load");
  assert.equal(calls.mermaid, 0, "a formula does not load Mermaid");
  // Drawn already: nothing to do on the next frame.
  assert.deepEqual(RB.richBlocksHydrate(root), { math: 0, mermaid: 0 });
});

test("a diagram loads Mermaid once, hides the source and shows the SVG", async () => {
  const root = rootOf("```mermaid\ngraph TD\nA-->B\n```");
  assert.deepEqual(RB.richBlocksHydrate(root), { math: 0, mermaid: 1 });
  const el = root.els[0];
  await until(() => el.getAttribute("data-rb-done") === "light");
  assert.match(el.querySelector(".rb-diagram").innerHTML, /^<svg id="rbmm\d+"><text>14<\/text><\/svg>$/);
  assert.equal(el.querySelector(".rb-diagram").hidden, false);
  assert.equal(el.querySelector("pre").hidden, true);
  assert.equal(calls.mermaid, 1);
  assert.deepEqual(RB.richBlocksHydrate(root), { math: 0, mermaid: 0 });
});

test("no DOMPurify, no drawn markup: the source stays on screen", async () => {
  const keep = globalThis.DOMPurify;
  globalThis.DOMPurify = undefined;
  try {
    const root = rootOf("Only $q_9$ here.");
    RB.richBlocksHydrate(root);
    await until(() => root.els[0].getAttribute("data-rb-done") === "fail");
    assert.equal(root.els[0].innerHTML, "");
  } finally { globalThis.DOMPurify = keep; }
});
