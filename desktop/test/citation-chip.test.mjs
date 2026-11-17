// ATO-1628: citation links from `files.search` (the My files contract) become
// chips that open the cited file at the page. The link parsing, the chip's
// markup, and md-render.js handing such a link to it. No deps, no build.
// Run: npm run test:unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const C = require("../renderer/citation-chip.js");

test("a PDF page citation", () => {
  assert.deepEqual(C.citeParse("file:///Users/me/Docs/report.pdf#page=12"), { path: "/Users/me/Docs/report.pdf", name: "report.pdf", page: 12 });
  assert.deepEqual(C.citeParse("file://localhost/Users/me/a.pdf#page=1"), { path: "/Users/me/a.pdf", name: "a.pdf", page: 1 });
});

test("a media time citation, in seconds", () => {
  assert.deepEqual(C.citeParse("file:///Users/me/Audio/call.m4a#t=83"), { path: "/Users/me/Audio/call.m4a", name: "call.m4a", t: 83 });
  assert.equal(C.citeParse("file:///a/v.mp4#t=83.6").t, 83);
  assert.equal(C.citeParse("file:///a/v.mp4#t=10,20").t, 10, "a range starts at its first number");
});

test("percent-encoding is decoded (RFC 8089)", () => {
  const c = C.citeParse("file:///Users/me/My%20Docs/%D0%BE%D1%82%D1%87%D1%91%D1%82%20%231.pdf#page=3");
  assert.equal(c.path, "/Users/me/My Docs/отчёт #1.pdf");
  assert.equal(c.name, "отчёт #1.pdf");
  assert.equal(c.page, 3);
});

test("a Windows drive path", () => {
  assert.equal(C.citeParse("file:///C:/Users/me/Docs/report.pdf#page=2").path, "C:/Users/me/Docs/report.pdf");
});

test("what is not a citation is left alone", () => {
  for (const bad of [
    "file:///Users/me/notes.md",            // no fragment: the old file-link path handles it
    "file:///Users/me/a.pdf#page=0",
    "file:///Users/me/a.pdf#page=-2",
    "file:///Users/me/a.pdf#page=abc",
    "file:///Users/me/a.pdf#zoom=50",
    "file:///Users/me/a.m4a#t=",
    "file:///Users/me/a.m4a#t=1:23",
    "https://example.com/a.pdf#page=2",
    "file://server/share/a.pdf#page=2",     // a host other than localhost
    "file:///Users/me/../etc/passwd#page=1",
    "file:///Users/me/%E0%A4%A.pdf#page=1", // broken encoding
    "file:///Users/me/a%00b.pdf#page=1",
    "file:///Users/me/dir/#page=1",
    "javascript:alert(1)#page=1",
    "",
    null,
  ]) {
    assert.equal(C.citeParse(bad), null, String(bad));
  }
});

test("times read as m:ss and h:mm:ss", () => {
  assert.equal(C.citeTimeText(83), "1:23");
  assert.equal(C.citeTimeText(5), "0:05");
  assert.equal(C.citeTimeText(3723), "1:02:03");
});

test("the chip's label is the link's text, or name and page", () => {
  const c = C.citeParse("file:///a/report.pdf#page=12");
  assert.equal(C.citeLabel(c, "report.pdf, p. 12"), "report.pdf, p. 12");
  assert.equal(C.citeLabel(c, ""), "report.pdf, p. 12");
  assert.equal(C.citeLabel(C.citeParse("file:///a/call.m4a#t=83"), ""), "call.m4a, 1:23");
});

test("the chip carries the decoded path and page, escaped, and an Open button", () => {
  const html = C.citeChipFromLink('file:///Users/me/%22quoted%22%20%3Cdoc%3E.pdf#page=7', 'a <b> "doc"');
  assert.match(html, /^<span class="citechip" role="button" tabindex="0" data-cite-path="\/Users\/me\/&quot;quoted&quot; &lt;doc&gt;\.pdf" data-cite-page="7"/);
  assert.match(html, /<span class="cite-tx">a &lt;b&gt; &quot;doc&quot;<\/span>/);
  assert.match(html, /data-cite-open="1"/);
  assert.doesNotMatch(html, /<b>|"doc"/);
  assert.match(C.citeChipFromLink("file:///a/call.m4a#t=83", "call"), /data-cite-t="83"/);
  assert.equal(C.citeChipFromLink("file:///a/notes.md", "notes"), "");
});

test("md-render.js hands a citation link to the chip and leaves other file links as before", () => {
  vm.runInThisContext(readFileSync(new URL("../renderer/vendor/marked.js", import.meta.url), "utf8"));
  const { mdRender } = require("../renderer/md-render.js");
  const md = (s) => { const o = mdRender(s); return o.html.replace(/\u0000(\d+)\u0000/g, (m, i) => o.held[+i]); };
  globalThis.citeChipFromLink = C.citeChipFromLink;
  try {
    const out = md("See [report.pdf, p. 12](file:///Users/me/My%20Docs/report.pdf#page=12) for the table.");
    assert.match(out, /^See <span class="citechip"[^>]* data-cite-path="\/Users\/me\/My Docs\/report\.pdf" data-cite-page="12"/);
    assert.match(out, /<span class="cite-tx">report\.pdf, p\. 12<\/span>/);
    assert.match(out, / for the table\.$/);
    // The chip is held: a later pass over the text sees a placeholder, not the path in its attributes.
    const o = mdRender("[a.pdf, p. 2](file:///Users/me/a.pdf#page=2)");
    assert.doesNotMatch(o.html, /\/Users\/me\/a\.pdf/);
    // No fragment: the old behaviour, the path as text for renderProse's chip pass.
    assert.equal(md("see [~/a.md](file://~/a.md)"), "see ~/a.md");
  } finally {
    delete globalThis.citeChipFromLink;
  }
  // Without citation-chip.js loaded (the mini chat), a citation stays the old text form.
  assert.equal(md("[a.pdf, p. 2](file:///Users/me/a.pdf#page=2)"), "a.pdf, p. 2 (/Users/me/a.pdf#page=2)");
});

test("the preview opens a PDF at the page and says File not found for a cited file that is gone", () => {
  const fp = readFileSync(new URL("../renderer/file-preview.js", import.meta.url), "utf8");
  assert.match(fp, /const frag = opts && opts\.page > 0 \? '#page=' \+ Math\.floor\(opts\.page\) : '';/);
  assert.match(fp, /pdf\.src = FP\.blobUrl \+ FP\.frag;/);
  const { fpBodyHtml, FP } = require("../renderer/file-preview.js");
  FP.cite = true; FP.path = "/Users/me/gone.pdf";
  assert.match(fpBodyHtml({ ok: false, reason: "missing" }), /File not found.*\/Users\/me\/gone\.pdf/);
  FP.cite = false;
  assert.doesNotMatch(fpBodyHtml({ ok: false, reason: "missing" }), /File not found/);
});

test("wired: loaded before md-render.js, styles linked", () => {
  const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
  const at = html.indexOf('src="citation-chip.js"');
  assert.ok(at !== -1 && at < html.indexOf('src="md-render.js"'));
  assert.ok(html.includes('href="css/citation-chip.css"'));
  const css = readFileSync(new URL("../renderer/css/citation-chip.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(/i, "theme tokens only");
});
