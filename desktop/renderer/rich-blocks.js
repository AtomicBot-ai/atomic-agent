/* ---------------- ATO-1140: formulas and diagrams in a reply ----------------
   Loaded after md-render.js, before renderer.js; declares only. Shared by the
   renderer and the Node checks (test/rich-blocks.test.mjs).

   Two parts:
   1. Parsing (md-render.js calls in when this file is loaded). Formulas are
      marked extensions, so a `$` in a code span or a fence is never one:
        $$ … $$ and \[ … \]   a display formula (a block of its own, or inline)
        \( … \)               an inline formula
        $ … $                 an inline formula, on Pandoc's terms so prices
                              stay prices: no space just inside either `$`, no
                              line break, and the closing `$` is not followed
                              by a digit or a letter ("$5 and $10" is text).
      A closed ```mermaid fence is a diagram block; an open one (still
      streaming) stays an ordinary code block until its fence closes.
      Both are written as placeholders that show the source as it was typed,
      and carry `data-morph-keep` keyed on the source, so a stream frame
      (dom-morph.js) leaves a drawn formula or diagram alone and only a
      changed one is drawn again.
   2. Drawing (richBlocksHydrate, called after each transcript paint). The
      libraries are NOT in index.html: KaTeX (with its CSS and fonts) and
      Mermaid are loaded from the window's own vendor/ folder the first time a
      placeholder of theirs is on screen, one shared promise each. Copied
      there at build by scripts/vendor-math.mjs; the window's CSP
      (script-src 'self', font-src 'self', connect-src 'none') is unchanged.
      KaTeX runs with trust off and its markup goes through DOMPurify (HTML,
      MathML and SVG profiles); Mermaid runs with securityLevel "strict",
      plain SVG labels (no foreignObject) and its SVG goes through DOMPurify's
      SVG profile. Anything that fails leaves the source on screen.
   ----------------------------------------------------------------------- */

const RB_INLINE_MAX = 2000;
const RB_BLOCK_MAX = 20000;

function rbEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
}
/** A short stable key for a piece of source (FNV-1a). */
function rbHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + s.length.toString(36);
}

/* ---------------- 1. parsing ---------------- */

const RB_INLINE_DOLLAR = /^\$(?![\s$])((?:\\.|[^\\\n$])*?[^\s\\$])\$(?![\p{L}\p{N}$])/u;

/** A formula at the very start of `src` (inline context): {raw, tex, display} or null. */
function rbMathAt(src) {
  let m = /^\$\$(?!\$)((?:(?!\n[ \t]*\n)[\s\S])+?)\$\$(?!\$)/.exec(src);
  if (m && m[1].trim() && m[1].length <= RB_BLOCK_MAX) return {raw: m[0], tex: m[1].trim(), display: true};
  if (src[0] === '$' && src[1] === '$') return null;
  m = /^\\\[((?:(?!\n[ \t]*\n)[\s\S])+?)\\\]/.exec(src);
  if (m && m[1].trim() && m[1].length <= RB_BLOCK_MAX) return {raw: m[0], tex: m[1].trim(), display: true};
  m = /^\\\(((?:(?!\n)[\s\S])+?)\\\)/.exec(src);
  if (m && m[1].trim() && m[1].length <= RB_INLINE_MAX) return {raw: m[0], tex: m[1].trim(), display: false};
  m = RB_INLINE_DOLLAR.exec(src);
  if (m && m[1].length <= RB_INLINE_MAX) return {raw: m[0], tex: m[1], display: false};
  return null;
}

/** A display formula as a block of its own: `$$` or `\[` opening a line, closed before a blank line. */
function rbMathBlockAt(src) {
  const m = /^ {0,3}\$\$((?:(?!\n[ \t]*\n)[\s\S])+?)\$\$[ \t]*(?:\n+|$)/.exec(src)
    || /^ {0,3}\\\[((?:(?!\n[ \t]*\n)[\s\S])+?)\\\][ \t]*(?:\n+|$)/.exec(src);
  if (!m || !m[1].trim() || m[1].length > RB_BLOCK_MAX) return null;
  return {raw: m[0], tex: m[1].trim(), display: true};
}

const RB_MD_EXTENSIONS = [
  {
    name: 'rbmathblock', level: 'block',
    start(src) { const m = /(?:^|\n) {0,3}(?:\$\$|\\\[)/.exec(src); return m ? m.index + (m[0][0] === '\n' ? 1 : 0) : undefined; },
    tokenizer(src) { const r = rbMathBlockAt(src); return r ? {type: 'rbmath', raw: r.raw, text: r.tex, display: true} : undefined; },
  },
  {
    name: 'rbmath', level: 'inline',
    // Not a `$` right after a backslash: `\$5` is marked's escape, a plain dollar.
    start(src) { const m = /(?<!\\)\$|\\[(\[]/.exec(src); return m ? m.index : undefined; },
    tokenizer(src) { const r = rbMathAt(src); return r ? {type: 'rbmath', raw: r.raw, text: r.tex, display: r.display} : undefined; },
  },
];

/** A formula's placeholder: the source as typed until KaTeX draws it. One line of markup. */
function rbMathHtml(tex, display, raw) {
  const t = String(tex);
  const shown = raw != null ? String(raw) : (display ? '$$' + t + '$$' : '$' + t + '$');
  return '<span class="rb-math' + (display ? ' rb-display' : '') + '" data-rb-kind="math"'
    + ' data-morph-keep="mx:' + rbHash((display ? 'd' : 'i') + t) + '"'
    + ' data-rb-tex="' + rbEsc(t) + '"' + (display ? ' data-rb-display="1"' : '') + '>' + rbEsc(shown) + '</span>';
}

/** A closed ```mermaid fence as a diagram block (Copy still copies its source); '' for anything else. */
function rbMermaidHtml(t) {
  if (!t || t.type !== 'code' || t.codeBlockStyle === 'indented') return '';
  const lang = (/^[\w+#.-]+/.exec(String(t.lang || '').trim()) || [''])[0].toLowerCase();
  if (lang !== 'mermaid') return '';
  const lines = String(t.raw || '').replace(/\n+$/, '').split('\n');
  const closed = lines.length > 1 && /^ {0,3}(?:`{3,}|~{3,})[ \t]*$/.test(lines[lines.length - 1]);
  const code = String(t.text || '').replace(/\n+$/, '');
  if (!closed || !code.trim() || code.length > RB_BLOCK_MAX) return '';
  const icon = typeof ic === 'function' ? ic('copy') : '';
  return '<div class="mdblock rb-mermaid" data-rb-kind="mermaid" data-morph-keep="mm:' + rbHash(code) + '">'
    + '<div class="mdbar"><span class="mdlang">mermaid</span>'
    + '<button class="mdcopy" data-mdcopy title="Copy diagram source" aria-label="Copy diagram source">' + icon + '<span>Copy</span></button></div>'
    + '<pre class="mdpre" data-lang="mermaid"><code>' + rbEsc(code) + '\n</code></pre>'
    + '<div class="rb-diagram" hidden></div></div>';
}

/* ---------------- 2. drawing ---------------- */

/** How each library is fetched: its own files, injected once. Tests swap these. */
const RB_LOADERS = {
  katex: () => Promise.all([
    rbInjectCss('vendor/katex/katex.min.css'),
    rbInjectScript('vendor/katex/katex.min.js', 'katex'),
  ]).then((r) => r[1]),
  mermaid: () => rbInjectScript('vendor/mermaid/mermaid.min.js', 'mermaid'),
};
const RB_LOADING = {};   // name → the one promise for it (a failed load is not retried each frame)
const RB_CACHE = new Map();   // key → drawn markup, so a chat opened again is drawn at once
const RB_CACHE_MAX = 200;
const RB_BUSY = typeof WeakSet === 'function' ? new WeakSet() : null;
let RB_MM_CHAIN = Promise.resolve();   // Mermaid draws one diagram at a time
let RB_MM_THEME = '';
let RB_MM_SEQ = 0;

function rbInjectScript(src, globalName) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => (window[globalName] ? resolve(window[globalName]) : reject(new Error(globalName + ' did not load')));
    s.onerror = () => reject(new Error('could not load ' + src));
    document.head.appendChild(s);
  });
}
function rbInjectCss(href) {
  return new Promise((resolve) => {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = href;
    // Drawn either way: without the stylesheet a formula is still readable.
    l.onload = () => resolve();
    l.onerror = () => resolve();
    document.head.appendChild(l);
  });
}

function rbLoad(name) {
  if (!RB_LOADING[name]) {
    const p = Promise.resolve().then(() => RB_LOADERS[name]());
    p.catch(() => {});
    RB_LOADING[name] = p;
  }
  return RB_LOADING[name];
}

function rbCachePut(key, html) {
  RB_CACHE.delete(key);
  RB_CACHE.set(key, html);
  if (RB_CACHE.size > RB_CACHE_MAX) RB_CACHE.delete(RB_CACHE.keys().next().value);
}

function rbTheme() {
  const doc = typeof document !== 'undefined' ? document : null;
  const set = doc && doc.documentElement ? doc.documentElement.getAttribute('data-theme') : '';
  if (set === 'dark' || set === 'light') return set;
  const mm = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  return mm && mm.matches ? 'dark' : 'light';
}

function rbPurify(html, profiles, addTags) {
  const P = typeof DOMPurify !== 'undefined' ? DOMPurify : null;
  if (!P || typeof P.sanitize !== 'function') return '';   // no wall, no markup: the source stays
  return P.sanitize(html, {USE_PROFILES: profiles, ADD_TAGS: addTags || [], FORBID_TAGS: ['script', 'foreignObject', 'iframe'], FORBID_ATTR: ['srcset']});
}

function rbDrawMath(el, katex) {
  RB_BUSY && RB_BUSY.delete(el);
  if (!el.isConnected && el.isConnected !== undefined) return;
  const key = el.getAttribute('data-morph-keep');
  let html = RB_CACHE.get(key);
  if (html == null) {
    const tex = el.getAttribute('data-rb-tex') || '';
    try {
      html = rbPurify(katex.renderToString(tex, {
        displayMode: el.getAttribute('data-rb-display') === '1',
        throwOnError: false, trust: false, strict: 'ignore', output: 'htmlAndMathml', maxSize: 50, maxExpand: 1000,
      }), {html: true, mathMl: true, svg: true}, ['semantics', 'annotation']);
    } catch (e) { html = ''; }
    if (html) rbCachePut(key, html);
  }
  if (!html) { el.setAttribute('data-rb-done', 'fail'); return; }
  el.innerHTML = html;
  el.setAttribute('data-rb-done', '1');
}

function rbMermaidInit(mermaid, theme) {
  if (RB_MM_THEME === theme) return;
  mermaid.initialize({
    startOnLoad: false, securityLevel: 'strict', theme: theme === 'dark' ? 'dark' : 'default',
    htmlLabels: false, flowchart: {htmlLabels: false},
  });
  RB_MM_THEME = theme;
}

async function rbDrawMermaid(el, mermaid, theme) {
  const key = el.getAttribute('data-morph-keep');
  const box = el.querySelector('.rb-diagram');
  const pre = el.querySelector('pre');
  const code = el.querySelector('pre code');
  if (!box || !code) return;
  const ck = key + ':' + theme;
  let svg = RB_CACHE.get(ck);
  if (svg == null) {
    const src = code.textContent.replace(/\n$/, '');
    const id = 'rbmm' + (++RB_MM_SEQ);
    try {
      rbMermaidInit(mermaid, theme);
      await mermaid.parse(src);
      const out = await mermaid.render(id, src);
      svg = rbPurify(out && out.svg ? out.svg : '', {svg: true, svgFilters: true}, ['style']);
    } catch (e) {
      svg = '';
    } finally {
      // Mermaid leaves its scratch element behind when a diagram fails.
      const tmp = document.getElementById('d' + id);
      if (tmp && tmp.parentNode) tmp.parentNode.removeChild(tmp);
    }
    if (svg) rbCachePut(ck, svg);
  }
  // A frame may have replaced the block while Mermaid worked.
  if (el.isConnected === false || el.getAttribute('data-morph-keep') !== key) return;
  if (!svg) { el.setAttribute('data-rb-done', 'fail'); return; }
  box.innerHTML = svg;
  box.hidden = false;
  if (pre) pre.hidden = true;
  el.setAttribute('data-rb-done', theme);
}

/**
 * Draws every formula and diagram placeholder under `root` that is not drawn
 * yet (a diagram drawn in the other theme counts as not drawn). Loads a
 * library only when a placeholder of its kind is there. Returns what it
 * found: {math, mermaid} counts.
 */
function richBlocksHydrate(root) {
  const found = {math: 0, mermaid: 0};
  if (!root || typeof root.querySelectorAll !== 'function') return found;
  const els = root.querySelectorAll('[data-rb-kind]');
  if (!els || !els.length) return found;
  const theme = rbTheme();
  const math = [], mm = [];
  for (const el of Array.from(els)) {
    if (RB_BUSY && RB_BUSY.has(el)) continue;
    const kind = el.getAttribute('data-rb-kind');
    const done = el.getAttribute('data-rb-done');
    if (done === 'fail') continue;
    if (kind === 'math' && !done) math.push(el);
    else if (kind === 'mermaid' && done !== theme) mm.push(el);
  }
  found.math = math.length;
  found.mermaid = mm.length;
  for (const el of math.concat(mm)) RB_BUSY && RB_BUSY.add(el);
  if (math.length) {
    rbLoad('katex').then((k) => { for (const el of math) rbDrawMath(el, k); },
      () => { for (const el of math) { RB_BUSY && RB_BUSY.delete(el); el.setAttribute('data-rb-done', 'fail'); } });
  }
  if (mm.length) {
    rbLoad('mermaid').then((m) => {
      for (const el of mm) {
        RB_MM_CHAIN = RB_MM_CHAIN.then(() => rbDrawMermaid(el, m, theme)).catch(() => {}).then(() => { RB_BUSY && RB_BUSY.delete(el); });
      }
    }, () => { for (const el of mm) { RB_BUSY && RB_BUSY.delete(el); el.setAttribute('data-rb-done', 'fail'); } });
  }
  return found;
}

/* "System" theme following macOS into the other one: diagrams are drawn again in its colours. */
if (typeof window !== 'undefined' && window.matchMedia && typeof document !== 'undefined') {
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => richBlocksHydrate(document));
  } catch (e) { /* older engines: the next paint picks it up */ }
}

if (typeof module !== 'undefined') {
  module.exports = {rbMathAt, rbMathBlockAt, rbMathHtml, rbMermaidHtml, richBlocksHydrate, RB_LOADERS, RB_LOADING, RB_MD_EXTENSIONS, rbHash};
}
