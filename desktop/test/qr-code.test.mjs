// ATO-516: the QR encoder for the Telegram pairing link (renderer/qr-code.js).
// The code is read back here the way a scanner does after locating it:
// format bits, unmask, zigzag, de-interleave, Reed-Solomon syndromes, data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const Q = createRequire(import.meta.url)("../renderer/qr-code.js");

test("level M byte capacities match the standard's table for versions 1 to 10", () => {
  // ISO/IEC 18004 table 7, byte mode, level M.
  const cap = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
  for (let v = 1; v <= 10; v++) {
    assert.equal(Q.qrVersionFor(cap[v - 1]), v, "fits at v" + v);
    assert.equal(Q.qrVersionFor(cap[v - 1] + 1), v === 10 ? 0 : v + 1, "one more byte moves past v" + v);
  }
});

test("format bits for level M are the standard's (mask 0 is 101010000010010)", () => {
  assert.equal(Q.qrFormatBits(0), 0b101010000010010);
  // Every format word is a BCH(15,5) codeword: masking undone, divisible by the generator.
  for (let mask = 0; mask < 8; mask++) {
    let r = Q.qrFormatBits(mask) ^ 0x5412;
    for (let i = 14; i >= 10; i--) if ((r >>> i) & 1) r ^= 0x537 << (i - 10);
    assert.equal(r, 0, "mask " + mask);
  }
});

test("alignment pattern centres match the standard for versions 2, 7 and 10", () => {
  assert.deepEqual(Q.qrAlignmentPositions(1), []);
  assert.deepEqual(Q.qrAlignmentPositions(2), [6, 18]);
  assert.deepEqual(Q.qrAlignmentPositions(7), [6, 22, 38]);
  assert.deepEqual(Q.qrAlignmentPositions(10), [6, 28, 50]);
});

/* Evaluate the codeword polynomial at 2^j: zero for every j < ecc length when the block is intact. */
function syndromesZero(block, eccLen) {
  for (let j = 0; j < eccLen; j++) {
    let x = 1;
    for (let k = 0; k < j; k++) x = Q.qrGfMul(x, 2);
    let s = 0;
    for (const c of block) s = Q.qrGfMul(s, x) ^ c;
    if (s !== 0) return false;
  }
  return true;
}

test("Reed-Solomon: data plus its remainder is a codeword", () => {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  const ecc = Q.qrRsRemainder(data, Q.qrRsDivisor(10));
  assert.equal(ecc.length, 10);
  assert.ok(syndromesZero(data.concat(ecc), 10));
  const broken = data.concat(ecc);
  broken[3] ^= 1;
  assert.ok(!syndromesZero(broken, 10));
});

const ECC = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];

/* Read `text`'s code back and return the decoded string. */
function readBack(q) {
  const { modules: m, fn, mask, version: ver } = q;
  const size = m.length;
  assert.equal(size, ver * 4 + 17);
  // Finder patterns in three corners: a dark 7x7 ring with a dark 3x3 core.
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    assert.ok(m[cy][cx] && m[cy - 3][cx - 3] && !m[cy - 2][cx - 2] && m[cy - 1][cx - 1], "finder at " + cx + "," + cy);
  }
  // Format bits, first copy, as placed by the standard.
  let fmt = 0;
  const at = (x, y) => (m[y][x] ? 1 : 0);
  const pos = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  pos.forEach(([x, y], i) => { fmt |= at(x, y) << i; });
  assert.equal(fmt, Q.qrFormatBits(mask));
  assert.equal((fmt ^ 0x5412) >>> 13, 0, "level M");
  // Unmask and read the zigzag.
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (fn[y][x]) continue;
        bits.push(m[y][x] !== Q.qrMaskHit(mask, x, y) ? 1 : 0);
      }
    }
  }
  const raw = Math.floor(Q.qrRawModules(ver) / 8);
  const words = [];
  for (let i = 0; i < raw; i++) { let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j]; words.push(v); }
  // De-interleave into blocks.
  const nb = BLOCKS[ver], ecc = ECC[ver], nShort = nb - (raw % nb), shortLen = Math.floor(raw / nb);
  const lens = Array.from({ length: nb }, (_, i) => shortLen + (i < nShort ? 0 : 1));
  const blocks = lens.map(() => []);
  let k = 0;
  for (let i = 0; i < shortLen + 1; i++) {
    for (let b = 0; b < nb; b++) {
      const dataLen = lens[b] - ecc;
      if (i < dataLen) blocks[b].push(words[k++]);
    }
  }
  for (let i = 0; i < ecc; i++) for (let b = 0; b < nb; b++) blocks[b].push(words[k++]);
  assert.equal(k, raw);
  for (const b of blocks) assert.ok(syndromesZero(b, ecc), "every block is a Reed-Solomon codeword");
  const data = blocks.flatMap((b) => b.slice(0, b.length - ecc));
  // Byte mode, count, bytes.
  const dbits = data.flatMap((v) => [7, 6, 5, 4, 3, 2, 1, 0].map((s) => (v >>> s) & 1));
  let p = 0;
  const take = (n) => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | dbits[p++]; return v; };
  assert.equal(take(4), 0b0100, "byte mode");
  const n = take(ver <= 9 ? 8 : 16);
  const out = [];
  for (let i = 0; i < n; i++) out.push(take(8));
  return Buffer.from(out).toString("utf8");
}

test("the Telegram pairing link reads back, at the smallest version that holds it", () => {
  for (const link of [
    "https://t.me/abcde?start=123456",
    "https://t.me/AtomicAgentHelperBot?start=000042",
    "https://t.me/" + "a".repeat(32) + "?start=999999",
  ]) {
    const q = Q.qrBuild(link);
    assert.ok(q, link);
    assert.equal(q.version, Q.qrVersionFor(Buffer.byteLength(link)));
    assert.ok(q.version <= 4, "a t.me link fits in version 4");
    assert.equal(readBack(q), link);
  }
});

test("longer text uses the bigger versions, version info included, and still reads back", () => {
  for (const len of [1, 14, 15, 100, 140, 213]) {
    const text = "x".repeat(len - 1) + "!";
    const q = Q.qrBuild(text);
    assert.ok(q, "fits: " + len);
    assert.equal(readBack(q), text);
  }
  assert.equal(Q.qrBuild("y".repeat(214)), null, "past version 10: no code");
});

test("the SVG has a quiet zone, white ground, and an accessible name", () => {
  const svg = Q.qrSvg("https://t.me/abcde?start=123456", 'Scan "me"');
  const q = Q.qrEncode("https://t.me/abcde?start=123456");
  const n = q.length + 8;
  assert.ok(svg.startsWith('<svg class="qr-svg"'));
  assert.ok(svg.includes('viewBox="0 0 ' + n + " " + n + '"'));
  assert.ok(svg.includes('fill="#fff"'));
  assert.ok(svg.includes('aria-label="Scan &quot;me&quot;"'));
  assert.equal(Q.qrSvg("z".repeat(300)), "");
});

test("wiring: loaded before the pairing card and renderer.js", () => {
  const html = readFileSync(new URL("../renderer/index.html", import.meta.url), "utf8");
  const at = (f) => html.indexOf('<script src="' + f + '"');
  assert.ok(at("qr-code.js") > 0 && at("qr-code.js") < at("renderer.js"));
});
