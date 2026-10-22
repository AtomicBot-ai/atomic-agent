// ATO-824: a streaming reply repaints the transcript column every frame. With
// innerHTML every node was new, so a code block's Copy button flickered on
// hover and a press that spanned two frames never became a click. The column
// is now morphed (renderer/dom-morph.js): nodes whose markup did not change
// are the same nodes after the repaint.
//
// No DOM in node: a minimal tree with the handful of Node methods the morph
// uses stands in for it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { morphChildren } = require("../renderer/dom-morph.js");

class FakeNode {
  constructor(type, name) { this.nodeType = type; this.nodeName = name; this.parentNode = null; this.kids = []; }
  get firstChild() { return this.kids[0] || null; }
  get nextSibling() { const p = this.parentNode; if (!p) return null; return p.kids[p.kids.indexOf(this) + 1] || null; }
  detach() { if (this.parentNode) { this.parentNode.kids.splice(this.parentNode.kids.indexOf(this), 1); this.parentNode = null; } }
  appendChild(n) { n.detach(); n.parentNode = this; this.kids.push(n); return n; }
  insertBefore(n, ref) { n.detach(); n.parentNode = this; this.kids.splice(this.kids.indexOf(ref), 0, n); return n; }
  removeChild(n) { n.detach(); return n; }
  isEqualNode(o) {
    if (!o || o.nodeType !== this.nodeType || o.nodeName !== this.nodeName) return false;
    if (this.nodeType === 3) return this.nodeValue === o.nodeValue;
    const a = this.attrs, b = o.attrs;
    if (a.size !== b.size || [...a].some(([k, v]) => b.get(k) !== v)) return false;
    return this.kids.length === o.kids.length && this.kids.every((k, i) => k.isEqualNode(o.kids[i]));
  }
}
class FakeEl extends FakeNode {
  constructor(name, attrs) { super(1, name.toUpperCase()); this.attrs = new Map(Object.entries(attrs || {})); }
  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  removeAttribute(k) { this.attrs.delete(k); }
}
class FakeText extends FakeNode {
  constructor(v) { super(3, "#text"); this.nodeValue = v; }
}
const h = (name, attrs, ...kids) => { const e = new FakeEl(name, attrs); kids.forEach((k) => e.appendChild(typeof k === "string" ? new FakeText(k) : k)); return e; };
const frag = (...kids) => h("#fragment", {}, ...kids);

/** One streaming reply: a finished code block with its Copy button, then the text still coming. */
const reply = (tail, cls = "turn") => h("div", { class: cls, id: "turn-r" },
  h("div", { class: "prose" }, "Here:",
    h("div", { class: "mdblock" }, h("div", { class: "mdbar" }, h("button", { class: "mdcopy", "data-mdcopy": "" }, "Copy")),
      h("pre", { class: "mdpre" }, h("code", {}, "npm test"))),
    tail));

test("a finished code block's Copy button is the same node after the next frame", () => {
  const col = frag(h("div", { class: "turn usr" }, "run the tests"), reply("Then"));
  const copy = col.kids[1].kids[0].kids[1].kids[0].kids[0];
  const text = col.kids[1].kids[0].kids[2];
  morphChildren(col, frag(h("div", { class: "turn usr" }, "run the tests"), reply("Then check the output")));
  assert.equal(col.kids[1].kids[0].kids[1].kids[0].kids[0], copy, "Copy kept its identity");
  assert.equal(col.kids[1].kids[0].kids[2], text, "the growing text node is kept too");
  assert.equal(text.nodeValue, "Then check the output");
});

test("a changed attribute is brought in line without replacing the element", () => {
  const col = frag(reply("x"));
  const row = col.kids[0];
  morphChildren(col, frag(reply("x", "turn done")));
  assert.equal(col.kids[0], row);
  assert.equal(row.getAttribute("class"), "turn done");
});

test("a row spliced in before the reply is inserted; the reply keeps its nodes", () => {
  const col = frag(reply("x"));
  const row = col.kids[0];
  morphChildren(col, frag(h("div", { class: "turn tk-step", id: "turn-a" }, "Reasoning"), reply("xy")));
  assert.equal(col.kids.length, 2);
  assert.equal(col.kids[0].getAttribute("id"), "turn-a");
  assert.equal(col.kids[1], row);
});

test("the result matches the new markup: extra old nodes go, missing ones come, other kinds are replaced", () => {
  const col = frag(h("p", {}, "a"), h("div", { hidden: "" }, "b"), h("span", {}, "c"));
  const want = () => frag(h("div", {}, "b2"), h("ul", {}, h("li", {}, "1")));
  morphChildren(col, want());
  assert.ok(col.isEqualNode(want()));
});

test("renderer.js morphs the transcript column and index.html loads the morph first", () => {
  const src = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
  const at = src.indexOf("\nfunction repaintTranscript(");
  const body = src.slice(at, src.indexOf("\n}\n", at));
  assert.match(body, /morphChildren\(col, next\.content\)/);
  assert.doesNotMatch(body, /col\.innerHTML = /);
  const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
  assert.ok(html.indexOf('src="dom-morph.js"') > 0 && html.indexOf('src="dom-morph.js"') < html.indexOf('src="renderer.js"'));
});
