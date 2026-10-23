/* ---------------- ATO-669: forgiving search for the ⌘K palette ----------------
   Loaded before renderer.js, after vendor/fuzzysort.js; declares only. Shared
   by the renderer and the Node checks (test/fuzzy-match.test.mjs).

   The palette used to find only rows whose title contained the query as typed,
   so "mdl" found nothing and "telgram" missed Telegram. The ranks below keep
   every match the old search made, in the same order (exact, prefix, word
   prefix or slash alias, substring, context), and add two looser tiers after
   them: a subsequence match scored by fuzzysort (the library the TUI menus
   already use, vendored here because the renderer loads plain scripts), then
   a one-typo match (two neighbouring letters swapped, or one letter too many).
   Lower is better; Infinity means no match. */
const FUZZY_LIB = typeof fuzzysort !== 'undefined' ? fuzzysort
  : typeof require === 'function' ? require('./vendor/fuzzysort.js') : null;

/* fuzzysort's score is 0..1, higher better. Null when it does not match. */
function fuzzyLibScore(q, text) {
  if (!FUZZY_LIB || !q || !text) return null;
  const r = FUZZY_LIB.single(q, text);
  return r ? r.score : null;
}

/* The queries one typo away: neighbouring letters swapped ("modles"), or one
   letter dropped from a query with a letter too many ("telegrram"). Short
   queries get none, where a dropped letter would match almost anything. */
function fuzzyTypoVariants(q) {
  const out = new Set();
  if (q.length < 4) return [];
  for (let i = 0; i + 1 < q.length; i++) {
    if (q[i] !== q[i + 1]) out.add(q.slice(0, i) + q[i + 1] + q[i] + q.slice(i + 2));
  }
  if (q.length >= 5) for (let i = 0; i < q.length; i++) out.add(q.slice(0, i) + q.slice(i + 1));
  out.delete(q);
  return [...out];
}

/* The rank of one row for a query that is already trimmed and lowercased.
   `extra.cx` is the row's context line, `extra.sc` its shortcut or slash alias. */
function fuzzyRank(q, title, extra) {
  const e = extra || {};
  const t = String(title || '').toLowerCase();
  if (!q) return 0;
  if (t === q) return 0;
  if (t.startsWith(q)) return 1;
  if (t.split(/[\s·]+/).some((w) => w.startsWith(q))) return 2;
  if (t.includes(q)) return 3;
  if ((e.cx || '').toLowerCase().includes(q)) return 4;
  // The slash alias ("/llm", "/feed"): typed with or without its slash.
  if ((e.sc || '').startsWith('/') && e.sc.slice(1).startsWith(q.replace(/^\//, ''))) return 2;
  const s = fuzzyLibScore(q, t);
  if (s !== null) return 5 + (1 - s);
  let best = null;
  for (const v of fuzzyTypoVariants(q)) {
    const vs = fuzzyLibScore(v, t);
    if (vs !== null && (best === null || vs > best)) best = vs;
  }
  return best === null ? Infinity : 6 + (1 - best);
}

/* The items that match, best first; ties keep the order they came in. An
   empty query keeps every item in its existing order. */
function fuzzyFilter(q, items, textOf) {
  const list = items || [];
  if (!q) return list.slice();
  return list.map((item, i) => ({item, i, k:fuzzyRank(q, textOf(item))}))
    .filter((x) => x.k !== Infinity)
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map((x) => x.item);
}

if (typeof module !== 'undefined') module.exports = {fuzzyRank, fuzzyFilter, fuzzyTypoVariants, fuzzyLibScore};
