// ATO-2517 (review of #2111): a deck that links outside its file goes to
// neither LibreOffice nor PowerPoint, and that is decided by reading each
// .rels part as XML in its own encoding, not by a pattern over UTF-8 text.
// Tested against the built output (npm run build); throwaway folders only.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import zlib from "node:zlib";

const require = createRequire(import.meta.url);
const { decodeXmlBytes, isRelsName, relsLinksOut } = require("../out/main/deck-rels.js");
const { deckLinksOut } = require("../out/main/slide-render-plan.js");
const { openZip } = require("../out/main/office-preview.js");
const { renderSlides, slideOutcome } = require("../out/main/slide-render.js");
const { fpOfficeHtml } = require("../renderer/office-preview.js");

const home = mkdtempSync(join(tmpdir(), "rels-home-"));
const tmp = mkdtempSync(join(tmpdir(), "rels-tmp-"));
after(() => { for (const d of [home, tmp]) rmSync(d, { recursive: true, force: true }); });

/** A stored ZIP of `files` ({name: text or Buffer}), enough for openZip. */
function storedZip(files) {
  const locals = [], centrals = [];
  let off = 0;
  for (const [name, body] of Object.entries(files)) {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8"), nm = Buffer.from(name, "utf8"), crc = zlib.crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nm, data); centrals.push(ch, nm);
    off += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  const count = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
const RELS = "ppt/slides/_rels/slide1.xml.rels";
const deckWith = (rels, name = RELS) => storedZip({ "ppt/slides/slide1.xml": "<p:sld/>", [name]: rels });
const linksOut = (rels, name) => deckLinksOut(openZip(deckWith(rels, name)));
const rel = (attrs) => `<Relationships><Relationship Id="r" Type="http://schemas.openxmlformats.org/x/image" ${attrs}/></Relationships>`;
const EXTERNAL = rel('Target="file://h/s/p.png" TargetMode="External"');
const LOCAL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="/ppt/slideLayouts/slideLayout1.xml"/>'
  + "</Relationships>";
const utf16be = (s) => Buffer.from(s, "utf16le").swap16();

test("what PowerPoint itself writes stays local", () => {
  assert.equal(linksOut(LOCAL), false);
  assert.equal(linksOut(Buffer.from("\ufeff" + LOCAL, "utf8")), false, "UTF-8 with its mark");
  assert.equal(linksOut(Buffer.from("\ufeff" + LOCAL.replace("UTF-8", "UTF-16"), "utf16le")), false, "a genuine UTF-16 part is read, not refused");
  assert.equal(linksOut(rel('Target="../media/a.png" TargetMode="Internal"')), false);
  assert.equal(linksOut('<Relationships><!-- a <note> --><![CDATA[ <x TargetMode="External"/> ]]></Relationships>'), false, "a comment or CDATA is not a tag");
});

test("the review's bypasses: a character reference and UTF-16 both read as External", () => {
  // The review's failing-test sketch: regex over UTF-8 text said false for both.
  assert.equal(linksOut(rel('Target="file://h/s/p.png" TargetMode="&#69;xternal"')), true);
  assert.equal(linksOut(rel('Target="x.png" TargetMode="&#x45;xternal"')), true);
  assert.equal(linksOut(Buffer.from("\ufeff" + EXTERNAL, "utf16le")), true, "UTF-16LE with its mark");
  assert.equal(linksOut(Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be(EXTERNAL)])), true, "UTF-16BE with its mark");
  assert.equal(linksOut(Buffer.from(EXTERNAL, "utf16le")), true, "UTF-16LE with no mark");
  assert.equal(linksOut(utf16be(EXTERNAL)), true, "UTF-16BE with no mark");
});

test("a target that is itself outside the file links out, whatever TargetMode says", () => {
  assert.equal(linksOut(rel('Target="file://attacker/share/x.png"')), true);
  assert.equal(linksOut(rel('Target="\\\\attacker\\share\\x.png"')), true, "a UNC path");
  assert.equal(linksOut(rel('Target="//attacker/share/x.png"')), true);
  assert.equal(linksOut(rel('Target="http://example.invalid/p.png"')), true);
  assert.equal(linksOut(rel('Target="&#104;ttp://example.invalid/p.png"')), true, "the scheme spelled by reference");
  assert.equal(linksOut(rel('Target="x.png" TargetMode="ex&#x74;ernal "')), true, "any case, a space, a reference");
  assert.equal(linksOut(rel('Target="x.png" TargetMode="Linked"')), true, "anything but Internal");
  assert.equal(linksOut(rel('Target="x.png" pr:TargetMode="External"')), true, "a prefixed name");
  assert.equal(linksOut("<pr:Relationships><pr:Relationship Id='r' Target='x.png'\nTargetMode\n=\n'External'/></pr:Relationships>"), true);
});

test("what cannot be read well enough to tell fails closed", () => {
  const dtd = '<!DOCTYPE Relationships [<!ENTITY e "External">]>' + rel('Target="x.png" TargetMode="&e;"');
  assert.equal(linksOut(dtd), true, "a DOCTYPE can define the entity");
  assert.equal(linksOut('<!DOCTYPE R [<!ATTLIST Relationship TargetMode CDATA "External">]>' + rel('Target="x.png"')), true, "or a default value");
  assert.equal(linksOut(rel('Target="x.png" TargetMode="&ext;"')), true, "an undefined entity");
  assert.equal(linksOut(rel('Target="x.png" Target="y.png"')), true, "a repeated attribute");
  assert.equal(linksOut('<Relationships><Relationship Target="x.png'), true, "a tag with no end");
  assert.equal(linksOut('<Relationships><!-- no end'), true, "a comment with no end");
  assert.equal(linksOut(LOCAL.replace("UTF-8", "windows-1252")), true, "a legacy code page");
  assert.equal(linksOut(Buffer.from([0xff, 0xfe, 0, 0, 0x3c, 0, 0, 0])), true, "UTF-32");
  assert.equal(linksOut(Buffer.concat([Buffer.from(rel('Target="x.png"')), Buffer.from([0xc3, 0x28])])), true, "bytes that are not UTF-8");
  assert.equal(linksOut(Buffer.from("\ufeff" + EXTERNAL, "utf16le").subarray(0, 41)), true, "an odd UTF-16 length");
  assert.equal(decodeXmlBytes(Buffer.from("<a/>")), "<a/>");
  assert.equal(relsLinksOut(Buffer.alloc(0)), false, "an empty part has no relationship");
});

test("a relationship part is found under a percent-encoded name too", () => {
  assert.equal(isRelsName("ppt/slides/_rels/slide1.xml.rels"), true);
  assert.equal(isRelsName("ppt/slides/_rels/slide1.xml.r%65ls"), true);
  assert.equal(isRelsName("ppt/media/a%ZZ.png"), true, "an undecodable name is read too");
  assert.equal(isRelsName("ppt/media/image1.png"), false);
  assert.equal(linksOut(EXTERNAL, "ppt/slides/_rels/slide1.xml.r%65ls"), true);
});

test("Windows: a UTF-16 linked deck runs nothing, and the panel is told why", async () => {
  const p = join(home, "linked16.pptx");
  writeFileSync(p, deckWith(Buffer.from("\ufeff" + EXTERNAL, "utf16le")));
  const calls = [];
  const deps = {
    env: { ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows" }, home, tmp,
    exists: (x) => x.endsWith("POWERPNT.EXE") || x.endsWith("powershell.exe") || x.endsWith("soffice.com"),
    run: async (command) => { calls.push(command); return { ok: false }; },
  };
  assert.equal(await renderSlides(p, "win32", deps), null);
  assert.equal(await slideOutcome(p, "win32", deps), "links-out");
  assert.deepEqual(calls, [], "neither LibreOffice nor PowerPoint was started");
  const office = { type: "pptx", slides: [{ n: 1, title: "Plan", paras: [] }], renderable: true, renderFailed: "links-out" };
  const html = fpOfficeHtml({ ok: true, kind: "office", name: "d.pptx", office });
  assert.match(html, /links to files outside it/);
  assert.doesNotMatch(html, /Reload to try again/, "Reload can never help a deck refused on purpose");
});
