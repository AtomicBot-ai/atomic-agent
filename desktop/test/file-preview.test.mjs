// ATO-1053: the file preview panel.
// main/file-preview.ts is tested against the built output (npm run build),
// renderer/file-preview.js as a CommonJS module (its DOM half is behind
// `typeof document`). Throwaway folders only.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { filePreview, previewKindFor, previewRootsFor, decodeStart, looksBinary } = require("../out/main/file-preview.js");
const { parseDelimited, fpCsvDelim, fpFormatSize, fpHtmlDoc, fpLangFor, fpBodyHtml, FP_HTML_CSP } = require("../renderer/file-preview.js");

const home = mkdtempSync(join(tmpdir(), "fp-home-"));
const work = mkdtempSync(join(tmpdir(), "fp-work-"));
const outside = mkdtempSync(join(tmpdir(), "fp-outside-"));
after(() => { for (const d of [home, work, outside]) rmSync(d, { recursive: true, force: true }); });
const roots = [home, work];
const P = process.platform;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

test("kinds by extension", () => {
  assert.equal(previewKindFor(".md"), "markdown");
  assert.equal(previewKindFor(".HTML"), "html");
  assert.equal(previewKindFor(".csv"), "csv");
  assert.equal(previewKindFor(".tsv"), "tsv");
  assert.equal(previewKindFor(".ts"), "code");
  assert.equal(previewKindFor(".svg"), "code", "an SVG can carry script: it is shown as its text");
  assert.equal(previewKindFor(".log"), "text");
});

test("text, markdown and code come back as their text", async () => {
  writeFileSync(join(home, "notes.md"), "# Hi\n\n- a\n");
  const r = await filePreview(join(home, "notes.md"), roots, home, P);
  assert.equal(r.ok, true);
  assert.equal(r.kind, "markdown");
  assert.equal(r.text, "# Hi\n\n- a\n");
  assert.equal(r.truncated, false);
  const viaTilde = await filePreview("~/notes.md", roots, home, P);
  assert.equal(viaTilde.ok, true);
});

test("the working folder is a root too", async () => {
  writeFileSync(join(work, "out.csv"), "a,b\n1,2\n");
  const r = await filePreview(join(work, "out.csv"), roots, home, P);
  assert.equal(r.ok && r.kind, "csv");
  assert.deepEqual(previewRootsFor(["/h"], "/w"), ["/h", "/w"]);
  assert.deepEqual(previewRootsFor(["/h"], null), ["/h"]);
});

test("outside the roots, or a link that leads out, is refused without being read", async () => {
  writeFileSync(join(outside, "secret.txt"), "nope");
  assert.deepEqual(await filePreview(join(outside, "secret.txt"), roots, home, P), { ok: false, reason: "outside" });
  assert.deepEqual(await filePreview(join(home, "..", "..", outside, "secret.txt"), roots, home, P), { ok: false, reason: "outside" });
  symlinkSync(join(outside, "secret.txt"), join(home, "link.txt"));
  assert.deepEqual(await filePreview(join(home, "link.txt"), roots, home, P), { ok: false, reason: "outside" });
  assert.equal((await filePreview("file:///etc/passwd", roots, home, P)).ok, false);
  assert.equal((await filePreview("https://example.com/a.txt", roots, home, P)).ok, false);
  assert.equal((await filePreview("relative.txt", roots, home, P)).ok, false);
});

test("missing, and a folder", async () => {
  assert.deepEqual(await filePreview(join(home, "nothing.txt"), roots, home, P), { ok: false, reason: "missing" });
  mkdirSync(join(home, "dir"));
  assert.deepEqual(await filePreview(join(home, "dir"), roots, home, P), { ok: false, reason: "dir" });
  // a relative path or a folder outside the roots says nothing about whether it exists
  assert.deepEqual(await filePreview(".", roots, home, P), { ok: false, reason: "missing" });
  assert.deepEqual(await filePreview(outside, roots, home, P), { ok: false, reason: "outside" });
});

test("a large text file is cut, at a line and a whole character", async () => {
  const line = "строка ✓ line\n";
  writeFileSync(join(home, "big.log"), line.repeat(20000));
  const r = await filePreview(join(home, "big.log"), roots, home, P, { text: 4096 });
  assert.equal(r.truncated, true);
  assert.ok(r.text.length < 4096);
  assert.ok(r.text.endsWith("\n"));
  assert.ok(!r.text.includes("�"));
  assert.ok(r.size > 4096);
});

test("decodeStart steps back over a cut UTF-8 character", () => {
  const b = Buffer.from("ab✓", "utf8");
  assert.equal(decodeStart(b.subarray(0, 4), true), "ab");
  assert.equal(decodeStart(Buffer.from("﻿hi"), false), "hi");
});

test("pictures by their bytes, PDF by its header, binary as other", async () => {
  writeFileSync(join(home, "shot.png"), PNG);
  const img = await filePreview(join(home, "shot.png"), roots, home, P);
  assert.equal(img.kind, "image");
  assert.match(img.dataUrl, /^data:image\/png;base64,/);
  writeFileSync(join(home, "fake.png"), "not a picture");
  assert.equal((await filePreview(join(home, "fake.png"), roots, home, P)).kind, "text");
  writeFileSync(join(home, "doc.pdf"), "%PDF-1.4\n%fake\n");
  const pdf = await filePreview(join(home, "doc.pdf"), roots, home, P);
  assert.equal(pdf.kind, "pdf");
  assert.equal(Buffer.from(pdf.base64, "base64").toString("latin1").slice(0, 5), "%PDF-");
  writeFileSync(join(home, "blob.bin"), Buffer.from([1, 2, 0, 3]));
  const bin = await filePreview(join(home, "blob.bin"), roots, home, P);
  assert.equal(bin.kind, "other");
  assert.equal(bin.note, "binary");
  assert.equal(bin.text, undefined);
  assert.equal(looksBinary(Buffer.from("plain")), false);
});

test("a picture or PDF over its cap is not read", async () => {
  writeFileSync(join(home, "huge.png"), Buffer.concat([PNG, Buffer.alloc(2048)]));
  const r = await filePreview(join(home, "huge.png"), roots, home, P, { image: 1024 });
  assert.equal(r.kind, "other");
  assert.equal(r.note, "too-large");
  assert.equal(r.dataUrl, undefined);
});

test("parseDelimited: quotes, doubled quotes, newlines in a cell, CRLF, a row cap", () => {
  assert.deepEqual(parseDelimited('a,b\r\n"x, y","say ""hi"""\n"multi\nline",2', ",").rows,
    [["a", "b"], ["x, y", 'say "hi"'], ["multi\nline", "2"]]);
  assert.deepEqual(parseDelimited("a\tb\n1\t2", "\t").rows, [["a", "b"], ["1", "2"]]);
  const capped = parseDelimited("1\n2\n3\n4\n", ",", 2);
  assert.deepEqual(capped.rows, [["1"], ["2"]]);
  assert.equal(capped.more, true);
  assert.equal(fpCsvDelim("a;b;c\n1;2;3"), ";");
  assert.equal(fpCsvDelim("a,b\n"), ",");
});

test("sizes and languages", () => {
  assert.equal(fpFormatSize(512), "512 B");
  assert.equal(fpFormatSize(1536), "1.5 KB");
  assert.equal(fpFormatSize(5 * 1024 * 1024), "5 MB");
  assert.equal(fpLangFor(".tsx"), "ts");
  assert.equal(fpLangFor(".py"), "py");
});

test("HTML: a sandboxed frame without scripts, its own CSP first", () => {
  const doc = fpHtmlDoc("<script>alert(1)</script><p>x</p>");
  assert.ok(doc.startsWith('<!doctype html><meta http-equiv="Content-Security-Policy" content="' + FP_HTML_CSP + '">'));
  assert.match(FP_HTML_CSP, /default-src 'none'/);
  assert.doesNotMatch(FP_HTML_CSP, /script-src/);
  const body = fpBodyHtml({ ok: true, kind: "html", name: "a.html", ext: ".html", size: 10, mtimeMs: 1, text: "<script>x</script>", path: "/h/a.html" });
  assert.match(body, /<iframe class="fp-frame fp-html" data-fp-html="1" sandbox=""/);
  assert.doesNotMatch(body, /<script>/, "the page's text is set as srcdoc later, never parsed into the panel");
});

test("text in the panel is escaped; a name cannot break out of its attribute", () => {
  const body = fpBodyHtml({ ok: true, kind: "text", name: 'x"><img src=x onerror=alert(1)>', ext: ".txt", size: 5, mtimeMs: 1, text: "<b>hi</b>", path: "/h/x" });
  assert.match(body, /&lt;b&gt;hi&lt;\/b&gt;/);
  const csv = fpBodyHtml({ ok: true, kind: "csv", name: "a.csv", ext: ".csv", size: 5, mtimeMs: 1, text: "<i>a</i>,b\n<script>,2", path: "/h/a.csv" });
  assert.doesNotMatch(csv, /<script>|<i>/);
  const other = fpBodyHtml({ ok: true, kind: "other", name: '"><svg onload=alert(1)>', ext: ".bin", size: 5, mtimeMs: 1, note: "binary", path: "/h/b" });
  assert.doesNotMatch(other, /<svg onload/);
});

test("a truncated file says so", () => {
  const body = fpBodyHtml({ ok: true, kind: "text", name: "a.log", ext: ".log", size: 10 * 1024 * 1024, mtimeMs: 1, text: "x".repeat(100), truncated: true, path: "/h/a.log" });
  assert.match(body, /Showing the first 100 B of 10 MB/);
});
