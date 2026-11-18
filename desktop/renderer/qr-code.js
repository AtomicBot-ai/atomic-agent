/* ---------------- A small QR code encoder (ATO-516) ----------------
   Loaded BEFORE renderer.js, so it only declares. Shared by the renderer and
   the Node checks (test/qr-code.test.mjs). No DOM, no dependency.

   Enough for the Telegram pairing link (https://t.me/<bot>?start=<code>, at
   most 58 bytes): byte mode, error correction level M, versions 1 to 10
   (up to 213 bytes). The mask is picked by the standard's penalty score.
   Written from ISO/IEC 18004; the layout follows the well-known reference
   encoders (function patterns, zigzag placement, block interleaving). */

const QR_MAX_VERSION = 10;
/* Level M, by version (index 0 unused): error correction codewords per block, and the number of blocks. */
const QR_M_ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const QR_M_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
/* The two format bits for level M. */
const QR_M_FORMAT = 0;

/* Modules that carry data or error correction in a version (all but the function patterns). */
function qrRawModules(ver) {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const n = Math.floor(ver / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}

function qrDataCodewords(ver) {
  return Math.floor(qrRawModules(ver) / 8) - QR_M_ECC_PER_BLOCK[ver] * QR_M_BLOCKS[ver];
}

/* The smallest version whose level M byte-mode capacity holds `n` bytes, or 0. */
function qrVersionFor(n) {
  for (let ver = 1; ver <= QR_MAX_VERSION; ver++) {
    const countBits = ver <= 9 ? 8 : 16;
    if (4 + countBits + 8 * n <= qrDataCodewords(ver) * 8) return ver;
  }
  return 0;
}

/* ---- GF(256) and Reed-Solomon (primitive polynomial 0x11D, generator roots 2^0 .. 2^(d-1)). */
function qrGfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function qrRsDivisor(degree) {
  const out = new Array(degree).fill(0);
  out[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < out.length; j++) {
      out[j] = qrGfMul(out[j], root);
      if (j + 1 < out.length) out[j] ^= out[j + 1];
    }
    root = qrGfMul(root, 0x02);
  }
  return out;
}

function qrRsRemainder(data, divisor) {
  const out = new Array(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ out.shift();
    out.push(0);
    for (let i = 0; i < divisor.length; i++) out[i] ^= qrGfMul(divisor[i], factor);
  }
  return out;
}

/* The data codewords for `bytes` at `ver`: mode, count, data, terminator, padding. */
function qrDataBytes(bytes, ver) {
  const bits = [];
  const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(0x4, 4);
  put(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const cap = qrDataCodewords(ver) * 8;
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    out.push(v);
  }
  for (let pad = 0xec; out.length < cap / 8; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

/* Split into blocks, add each block's error correction, interleave. */
function qrInterleave(data, ver) {
  const numBlocks = QR_M_BLOCKS[ver], eccLen = QR_M_ECC_PER_BLOCK[ver];
  const raw = Math.floor(qrRawModules(ver) / 8);
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const div = qrRsDivisor(eccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const ecc = qrRsRemainder(dat, div);
    if (i < numShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const out = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= numShort) out.push(b[i]); });
  }
  return out;
}

function qrAlignmentPositions(ver) {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let pos = ver * 4 + 17 - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

/* The 15 format bits for level M and `mask`. */
function qrFormatBits(mask) {
  const data = (QR_M_FORMAT << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function qrMaskHit(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

/* The standard's penalty: runs, 2x2 blocks, finder-like patterns, dark balance. */
function qrPenalty(m) {
  const n = m.length;
  let p = 0;
  const line = (get) => {
    let run = 1;
    for (let i = 1; i <= n; i++) {
      if (i < n && get(i) === get(i - 1)) { run++; continue; }
      if (run >= 5) p += run - 2;
      run = 1;
    }
    const a = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], b = a.slice().reverse();
    for (let i = 0; i + 11 <= n; i++) {
      let ma = true, mb = true;
      for (let j = 0; j < 11; j++) {
        const v = get(i + j) ? 1 : 0;
        if (v !== a[j]) ma = false;
        if (v !== b[j]) mb = false;
      }
      if (ma) p += 40;
      if (mb) p += 40;
    }
  };
  for (let y = 0; y < n; y++) line((x) => m[y][x]);
  for (let x = 0; x < n; x++) line((y) => m[y][x]);
  let dark = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (m[y][x]) dark++;
      if (y + 1 < n && x + 1 < n) {
        const c = m[y][x];
        if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3;
      }
    }
  }
  const total = n * n;
  p += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return p;
}

/* The QR code for `text` (UTF-8, byte mode, level M): {version, mask, modules, fn}, rows of
   booleans (true = dark; `fn` marks the function patterns), or null when it does not fit. */
function qrBuild(text) {
  const bytes = Array.from(typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(String(text)) : Buffer.from(String(text), 'utf8'));
  const ver = qrVersionFor(bytes.length);
  if (!ver) return null;
  const size = ver * 4 + 17;
  const m = Array.from({length: size}, () => new Array(size).fill(false));
  const fn = Array.from({length: size}, () => new Array(size).fill(false));
  const set = (x, y, dark) => { m[y][x] = dark; fn[y][x] = true; };

  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, d !== 2 && d !== 4);
      }
    }
  }
  const al = qrAlignmentPositions(ver), last = al.length - 1;
  for (let i = 0; i < al.length; i++) {
    for (let j = 0; j < al.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  const drawFormat = (mask) => {
    const bits = qrFormatBits(mask);
    const bit = (i) => ((bits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  drawFormat(0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0, a = size - 11 + (i % 3), b = Math.floor(i / 3);
      set(a, b, dark); set(b, a, dark);
    }
  }

  const words = qrInterleave(qrDataBytes(bytes, ver), ver);
  let k = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
        if (fn[y][x] || k >= words.length * 8) continue;
        m[y][x] = ((words[k >>> 3] >>> (7 - (k & 7))) & 1) !== 0;
        k++;
      }
    }
  }

  const applyMask = (mask) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && qrMaskHit(mask, x, y)) m[y][x] = !m[y][x];
  };
  let best = 0, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask);
    drawFormat(mask);
    const score = qrPenalty(m);
    if (score < bestScore) { best = mask; bestScore = score; }
    applyMask(mask);
  }
  applyMask(best);
  drawFormat(best);
  return {version: ver, mask: best, modules: m, fn};
}

/* The modules alone (rows of booleans, true = dark), or null when `text` does not fit. */
function qrEncode(text) {
  const q = qrBuild(text);
  return q ? q.modules : null;
}

/* The code as an SVG (dark modules on white, a 4-module quiet zone), or '' when `text` does not fit.
   `label` is its accessible name. */
function qrSvg(text, label) {
  const m = qrEncode(text);
  if (!m) return '';
  const q = 4, n = m.length + q * 2;
  let d = '';
  for (let y = 0; y < m.length; y++) for (let x = 0; x < m.length; x++) if (m[y][x]) d += 'M' + (x + q) + ' ' + (y + q) + 'h1v1h-1z';
  const name = String(label || 'QR code').replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);
  return '<svg class="qr-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + ' ' + n + '" shape-rendering="crispEdges" role="img" aria-label="' + name + '">'
    + '<rect width="' + n + '" height="' + n + '" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
}

if (typeof module !== 'undefined') {
  module.exports = {QR_MAX_VERSION, qrRawModules, qrDataCodewords, qrVersionFor, qrGfMul, qrRsDivisor, qrRsRemainder,
    qrDataBytes, qrInterleave, qrAlignmentPositions, qrFormatBits, qrMaskHit, qrPenalty, qrBuild, qrEncode, qrSvg};
}
