// ATO-1025: a reply's code blocks take colour. code-highlight.js is loaded
// as a CommonJS module; codeBlockFrame is read from renderer.js as text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { highlightCode } = require("../renderer/code-highlight.js");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const text = (html) => html.replace(/<[^>]+>/g, "");

test("keywords, strings, numbers and comments get their classes", () => {
  const out = highlightCode(esc('const n = 42; // why\nlet s = "a<b";'), "js");
  assert.match(out, /<span class="hl-k">const<\/span>/);
  assert.match(out, /<span class="hl-n">42<\/span>/);
  assert.match(out, /<span class="hl-c">\/\/ why<\/span>/);
  assert.match(out, /<span class="hl-s">&quot;a&lt;b&quot;<\/span>/);
});

test("the text is unchanged once the spans are taken out", () => {
  for (const [code, lang] of [
    ['def f(x):\n    """doc"""\n    return x * 2  # twice', "python"],
    ["echo \"$HOME\" && ls -la | grep '.md'", "bash"],
    ['{"name": "a & b", "n": 1.5e3, "ok": true}', "json"],
    ["SELECT id FROM t WHERE a <> 'x' -- note", "sql"],
    ["<div class=\"a\">&amp;</div><!-- c -->", "html"],
  ]) {
    const escaped = esc(code);
    assert.equal(text(highlightCode(escaped, lang)), escaped, lang);
  }
});

test("a JSON key is not coloured as a value", () => {
  const out = highlightCode(esc('{"key": "value"}'), "json");
  assert.match(out, /<span class="hl-p">&quot;key&quot;<\/span>/);
  assert.match(out, /<span class="hl-s">&quot;value&quot;<\/span>/);
});

test("an unknown language or a huge block comes back as it went in", () => {
  assert.equal(highlightCode("x = 1", "brainfuck"), "x = 1");
  assert.equal(highlightCode("x = 1", ""), "x = 1");
  const big = "a ".repeat(20001);
  assert.equal(highlightCode(big, "js"), big);
});

test("codeBlockFrame highlights inside <code> and keeps Copy", () => {
  const source = readFileSync(new URL("../renderer/renderer.js", import.meta.url), "utf8");
  const at = source.indexOf("\nfunction codeBlockFrame(");
  const body = source.slice(at, source.indexOf("\n}\n", at));
  assert.match(body, /highlightCode\(code, lang\)/);
  assert.match(body, /data-mdcopy/);
  const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
  assert.ok(html.indexOf("<script src=\"code-highlight.js\"") < html.indexOf("<script src=\"renderer.js\""), "loaded before renderer.js");
});
