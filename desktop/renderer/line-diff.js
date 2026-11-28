/* ---------------- ATO-2445: a line diff of two texts, as a unified diff ----------------
   The preview's Compare (file-preview-compare.js) shows what is on disk
   against the text being edited. diff-lines.js only draws a unified diff the
   agent sent; this makes one: the common start and end are set aside, the
   rest is matched by a longest-common-subsequence table, and the changes come
   out in hunks with three lines of context, `--- a` / `+++ b` / `@@ -x,n +y,m @@`
   like `git diff`.

   Bounded: when the part that differs is more than LD_MAX_CELLS lines by
   lines, it is shown as all removed then all added instead of matched (still
   correct, only coarser), and the output stops at LD_MAX_LINES lines with a
   note. Nothing here touches the DOM.

   Shared with the Node checks (test/file-preview-line.test.mjs): lineDiff,
   unifiedDiff. */

const LD_MAX_CELLS = 4000000;
const LD_MAX_LINES = 5000;
const LD_CONTEXT = 3;

function ldLines(text) {
  const s = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  if (!s) return [];
  const lines = s.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** The edit script from `a` to `b`: [{op: ' '|'-'|'+', text}] line by line. */
function lineDiff(aText, bText) {
  const a = ldLines(aText), b = ldLines(bText);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf), B = b.slice(pre, b.length - suf);
  const out = a.slice(0, pre).map((t) => ({op: ' ', text: t}));
  const n = A.length, m = B.length;
  if (n && m && n * m <= LD_MAX_CELLS) {
    // lcs[i][j]: the longest common run of A[i..] and B[j..], in one flat table.
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = A[i] === B[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { out.push({op: ' ', text: A[i]}); i++; j++; }
      else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) out.push({op: '-', text: A[i++]});
      else out.push({op: '+', text: B[j++]});
    }
    while (i < n) out.push({op: '-', text: A[i++]});
    while (j < m) out.push({op: '+', text: B[j++]});
  } else {
    for (const t of A) out.push({op: '-', text: t});
    for (const t of B) out.push({op: '+', text: t});
  }
  for (const t of a.slice(a.length - suf)) out.push({op: ' ', text: t});
  return out;
}

/** The unified diff of `aText` → `bText` under the names `aName` / `bName`; '' when they are the same. */
function unifiedDiff(aText, bText, aName, bName) {
  const ops = lineDiff(aText, bText);
  if (!ops.some((o) => o.op !== ' ')) return '';
  const lines = ['--- ' + aName, '+++ ' + bName];
  let k = 0;
  // Each op's line number in a and in b, 1-based.
  const at = [];
  let la = 1, lb = 1;
  for (const o of ops) { at.push([la, lb]); if (o.op !== '+') la++; if (o.op !== '-') lb++; }
  while (k < ops.length) {
    if (ops[k].op === ' ') { k++; continue; }
    let start = Math.max(0, k - LD_CONTEXT), end = k;
    // A hunk runs on while the next change is within two contexts of the last one.
    for (;;) {
      while (end < ops.length && ops[end].op !== ' ') end++;
      let next = end;
      while (next < ops.length && ops[next].op === ' ' && next - end < LD_CONTEXT * 2) next++;
      if (next < ops.length && ops[next].op !== ' ' && next - end <= LD_CONTEXT * 2) { end = next; continue; }
      break;
    }
    const stop = Math.min(ops.length, end + LD_CONTEXT);
    const chunk = ops.slice(start, stop);
    const na = chunk.filter((o) => o.op !== '+').length, nb = chunk.filter((o) => o.op !== '-').length;
    const sa = na ? at[start][0] : at[start][0] - 1, sb = nb ? at[start][1] : at[start][1] - 1;
    lines.push('@@ -' + sa + ',' + na + ' +' + sb + ',' + nb + ' @@');
    for (const o of chunk) lines.push(o.op + o.text);
    if (lines.length > LD_MAX_LINES) { lines.length = LD_MAX_LINES; lines.push('… [diff truncated]'); return lines.join('\n'); }
    k = stop;
  }
  return lines.join('\n');
}

if (typeof module !== 'undefined') module.exports = {lineDiff, unifiedDiff, LD_MAX_CELLS};
