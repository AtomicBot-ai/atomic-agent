/* ---------------- ATO-1053: a file, previewed beside the chat ----------------
   Loaded before renderer.js. A click on a file chip (a path in a reply, the
   "Saved to" strip, an attachment) opens this panel on the right of the chat
   instead of handing the file to the system; ⌘/Ctrl-click still opens it in
   its default app. The chat stays usable: the panel is its own <aside> in
   #main, drawn here and never by render(), so a streaming reply does not
   rebuild it and it does not rebuild the reply.

   The window never reads the disk. main reads the file (main/file-preview.ts)
   inside the allowed roots and hands back the start of a text file, a
   picture as a data: URL, or a PDF's bytes. What is shown:
   - text and code (highlighted by code-highlight.js), markdown rendered by
     the reply's own renderer, CSV/TSV as a table, pictures, PDF (Chromium's
     viewer, in a frame of its own), HTML in a sandboxed frame with no
     scripts, no forms and no network (its own CSP on top of the window's);
   - anything else: its name and size, Open and Reveal.
   A large file shows its start and says so; nothing is read whole.

   The panel follows the file: while it is open, main is asked for the
   file's size and time every few seconds (app:statPaths) and a change
   reloads it, keeping the scroll. Refresh does the same by hand.

   Shared with the Node checks (test/file-preview.test.mjs): parseDelimited,
   fpFormatSize, fpHtmlDoc, fpLangFor. Everything that touches the DOM is
   behind `typeof document`. */

const FP_POLL_MS = 2500;
const FP_MD_MAX = 200 * 1024;          // markdown rendered; past this the rest shows as text
const FP_HL_MAX = 200 * 1024;          // code highlighted; past this, plain
const FP_TABLE_ROWS = 2000;
const FP_TABLE_COLS = 200;
const FP_WIDTH_KEY = 'atomic.filePreview.width';
const FP_MIN_W = 300;

/** CSV (RFC 4180: quotes, doubled quotes, newlines inside quotes) or TSV, at most `maxRows` rows. */
function parseDelimited(text, delim, maxRows) {
  const rows = [];
  const limit = maxRows || Infinity;
  let row = [], cell = '', q = false, i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        q = false; i++; continue;
      }
      cell += c; i++; continue;
    }
    if (c === '"' && cell === '') { q = true; i++; continue; }
    if (c === delim) { row.push(cell); cell = ''; i++; continue; }
    if (c === '\r' || c === '\n') {
      row.push(cell); cell = '';
      rows.push(row); row = [];
      if (c === '\r' && text[i + 1] === '\n') i++;
      i++;
      if (rows.length >= limit) return {rows, more: i < n};
      continue;
    }
    cell += c; i++;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return {rows, more: false};
}
/** A CSV's delimiter: `,` unless its first line has more `;` (the European export). */
function fpCsvDelim(text) {
  const first = text.slice(0, text.indexOf('\n') < 0 ? text.length : text.indexOf('\n'));
  const count = (ch) => first.split(ch).length - 1;
  return count(';') > count(',') ? ';' : ',';
}
function fpFormatSize(n) {
  if (!(n >= 0)) return '';
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB'];
  let v = n / 1024, k = 0;
  while (v >= 1024 && k < u.length - 1) { v /= 1024; k++; }
  return (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10) + ' ' + u[k];
}
/** The fence language code-highlight.js knows for a file's extension. */
function fpLangFor(ext) {
  const e = String(ext || '').replace(/^\./, '').toLowerCase();
  const map = {mjs: 'js', cjs: 'js', jsx: 'js', tsx: 'ts', yml: 'yaml', htm: 'html', xhtml: 'html', svg: 'html', xml: 'html', zsh: 'sh', bash: 'sh', fish: 'sh', jsonc: 'json', h: 'c', hpp: 'cpp', cc: 'cpp', kt: 'kotlin'};
  return map[e] || e;
}
/**
 * The document an HTML file is shown as: the file's own text after a CSP that
 * allows no script, no network, no frames and no forms — inside a frame that
 * is sandboxed as well (no allow-scripts, no allow-same-origin), so the page
 * can draw itself and nothing else.
 */
const FP_HTML_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; form-action 'none'; base-uri 'none'";
function fpHtmlDoc(text) {
  return '<!doctype html><meta http-equiv="Content-Security-Policy" content="' + FP_HTML_CSP + '"><meta charset="utf-8">' + String(text);
}

const FP = {open: false, path: '', reply: false, data: null, view: 'render', seq: 0, timer: 0, blobUrl: '', stamp: ''};

function fpEsc(s) { return String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c])); }
function fpIcon(n) { return typeof ic === 'function' ? ic(n) : ''; }
function fpBridge() { return typeof window !== 'undefined' ? window.atomic : null; }
function fpEl() { return typeof document !== 'undefined' ? document.getElementById('fpreview') : null; }

/** Open the panel on `path`. `reply`: the path came from a reply's text (its Open asks main's reply check). */
function filePreviewOpen(path, opts) {
  const el = fpEl();
  const br = fpBridge();
  if (!el || !br || !br.filePreview) return false;
  const same = FP.open && FP.path === path;
  FP.open = true; FP.path = path; FP.reply = !!(opts && opts.reply);
  if (!same) { FP.data = null; FP.view = 'render'; }
  el.hidden = false;
  fpApplyWidth();
  fpPaintHead();
  if (!same) fpPaintBody('<div class="fp-msg">Loading…</div>');
  fpLoad(false);
  fpPoll();
  return true;
}
function filePreviewClose() {
  const el = fpEl();
  FP.open = false; FP.data = null; FP.path = '';
  if (FP.timer) { clearTimeout(FP.timer); FP.timer = 0; }
  fpRevoke();
  if (el) { el.hidden = true; el.innerHTML = ''; }
}
function fpRevoke() { if (FP.blobUrl) { try { URL.revokeObjectURL(FP.blobUrl); } catch (e) { /* gone */ } FP.blobUrl = ''; } }

async function fpLoad(keepScroll) {
  const br = fpBridge();
  const seq = ++FP.seq;
  const path = FP.path;
  let res = null;
  try { res = await br.filePreview(path); } catch (e) { res = {ok: false, reason: 'missing'}; }
  if (seq !== FP.seq || !FP.open || FP.path !== path) return;   // a newer open won
  if (res && res.ok === false && res.reason === 'dir') {
    // A folder is not previewed: it opens in the file manager, as a click on its chip always did.
    filePreviewClose();
    fpOpenOutside(path);
    return;
  }
  const body = fpEl() && fpEl().querySelector('.fp-body');
  const top = keepScroll && body ? body.scrollTop : 0;
  FP.data = res;
  FP.stamp = res && res.ok ? res.size + ':' + res.mtimeMs : '';
  fpPaintHead();
  fpPaintBody(fpBodyHtml(res));
  const after = fpEl() && fpEl().querySelector('.fp-body');
  if (after && top) after.scrollTop = top;
}

/** While open: main's stat of the file every few seconds; a new size or time reloads it. */
function fpPoll() {
  if (FP.timer) clearTimeout(FP.timer);
  FP.timer = setTimeout(async () => {
    FP.timer = 0;
    if (!FP.open) return;
    const br = fpBridge();
    if (br && br.statPaths && FP.data && FP.data.ok && !(typeof document !== 'undefined' && document.hidden)) {
      let r = null;
      try { r = await br.statPaths([FP.data.path]); } catch (e) { r = null; }
      const f = r && r.ok && r.files && r.files[0];
      if (FP.open && f && f.exists && f.size + ':' + f.mtimeMs !== FP.stamp) await fpLoad(true);
    }
    if (FP.open) fpPoll();
  }, FP_POLL_MS);
}

function fpPaintHead() {
  const el = fpEl();
  if (!el) return;
  if (!el.querySelector('.fp-head')) {
    el.innerHTML = '<div class="fp-resize" data-fp="resize" title="Drag to resize" aria-hidden="true"></div>'
      + '<div class="fp-head"></div><div class="fp-body" tabindex="0"></div>';
  }
  const d = FP.data && FP.data.ok ? FP.data : null;
  const name = d ? d.name : String(FP.path).split(/[\\/]/).pop();
  const togglable = d && (d.kind === 'markdown' || d.kind === 'html' || d.kind === 'csv' || d.kind === 'tsv');
  const meta = d ? [d.kind === 'other' ? (d.ext || 'file').replace(/^\./, '').toUpperCase() : d.kind.toUpperCase(), fpFormatSize(d.size)].filter(Boolean).join(' · ') : '';
  el.querySelector('.fp-head').innerHTML = '<span class="fp-ic">' + fpIcon('doc') + '</span>'
    + '<span class="fp-title"><span class="fp-name" title="' + fpEsc(d ? d.path : FP.path) + '">' + fpEsc(name) + '</span>'
    + (meta ? '<span class="fp-meta">' + fpEsc(meta) + '</span>' : '') + '</span>'
    + (togglable ? '<button class="fp-btn fp-tog" data-fp="view" title="' + (FP.view === 'source' ? 'Show it rendered' : 'Show the source') + '">' + (FP.view === 'source' ? 'Preview' : 'Source') + '</button>' : '')
    + '<button class="fp-btn" data-fp="refresh" title="Reload the file" aria-label="Reload">↻</button>'
    + '<button class="fp-btn" data-fp="open" title="Open in its default app">Open</button>'
    + '<button class="fp-btn" data-fp="reveal" title="' + fpEsc(fpRevealLabel()) + '" aria-label="' + fpEsc(fpRevealLabel()) + '">' + fpIcon('folder') + '</button>'
    + '<button class="fp-btn fp-x" data-fp="close" title="Close the preview" aria-label="Close the preview">✕</button>';
}
function fpRevealLabel() {
  const p = typeof navigator !== 'undefined' ? String(navigator.platform || '') : '';
  return /Mac/i.test(p) ? 'Reveal in Finder' : /Win/i.test(p) ? 'Show in Explorer' : 'Show in folder';
}
function fpPaintBody(html) {
  const el = fpEl();
  if (!el) return;
  const body = el.querySelector('.fp-body');
  if (!body) return;
  fpRevoke();
  body.innerHTML = html;
  // PDF: the bytes become a blob the frame shows with Chromium's own viewer.
  const pdf = body.querySelector('iframe[data-fp-pdf]');
  if (pdf && FP.data && FP.data.base64) {
    try {
      const bin = atob(FP.data.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      FP.blobUrl = URL.createObjectURL(new Blob([bytes], {type: 'application/pdf'}));
      pdf.src = FP.blobUrl;
    } catch (e) { body.innerHTML = fpOtherHtml(FP.data, 'This PDF could not be shown here.'); }
  }
  // HTML: srcdoc set as a property, never parsed into this document.
  const page = body.querySelector('iframe[data-fp-html]');
  if (page && FP.data && typeof FP.data.text === 'string') page.srcdoc = fpHtmlDoc(FP.data.text);
}

function fpTruncNote(d) {
  return d.truncated ? '<div class="fp-note">Showing the first ' + fpFormatSize(d.text.length) + ' of ' + fpFormatSize(d.size) + '. Open the file to see all of it.</div>' : '';
}
function fpOtherHtml(d, why) {
  return '<div class="fp-other"><div class="fp-other-ic">' + fpIcon('doc') + '</div>'
    + '<div class="fp-other-n">' + fpEsc(d.name || '') + '</div>'
    + '<div class="fp-other-m">' + fpEsc(fpFormatSize(d.size)) + (why ? ' · ' + fpEsc(why) : '') + '</div>'
    + '<div class="fp-other-b"><button class="fp-btn fp-primary" data-fp="open">Open in default app</button>'
    + '<button class="fp-btn" data-fp="reveal">' + fpEsc(fpRevealLabel()) + '</button></div></div>';
}
function fpCodeHtml(text, lang) {
  const escaped = fpEsc(text);
  const lit = text.length <= FP_HL_MAX && typeof highlightCode === 'function' ? highlightCode(escaped, lang) : escaped;
  return '<div class="prose fp-prose"><pre class="mdpre fp-code"><code>' + lit + '</code></pre></div>';
}
function fpTableHtml(text, delim) {
  const {rows, more} = parseDelimited(text, delim, FP_TABLE_ROWS + 1);
  if (!rows.length) return '<div class="fp-msg">The file is empty.</div>';
  const shown = rows.slice(0, FP_TABLE_ROWS + 1);
  const cols = Math.min(FP_TABLE_COLS, shown.reduce((w, r) => Math.max(w, r.length), 0));
  const cell = (tag, v) => '<' + tag + '>' + fpEsc(v == null ? '' : v) + '</' + tag + '>';
  const head = shown[0];
  const body = shown.slice(1, FP_TABLE_ROWS + 1);
  const cut = more || rows.length > FP_TABLE_ROWS + 1;
  return (cut ? '<div class="fp-note">Showing the first ' + FP_TABLE_ROWS + ' rows.</div>' : '')
    + '<div class="prose fp-prose"><div class="mdtbl fp-tbl"><table><thead><tr>'
    + Array.from({length: cols}, (_, i) => cell('th', head[i])).join('') + '</tr></thead><tbody>'
    + body.map((r) => '<tr>' + Array.from({length: cols}, (_, i) => cell('td', r[i])).join('') + '</tr>').join('')
    + '</tbody></table></div></div>';
}
function fpMarkdownHtml(text) {
  const head = text.length > FP_MD_MAX ? text.slice(0, FP_MD_MAX) : text;
  // The reply's renderer: escaped first, its own tags only, paths as chips (main checks them).
  const html = typeof renderProseFresh === 'function' ? renderProseFresh(head) : fpEsc(head);
  return '<div class="prose fp-prose fp-md">' + html + '</div>'
    + (text.length > FP_MD_MAX ? '<div class="fp-note">The rest of the file is long; open it to read on.</div>' : '');
}

function fpBodyHtml(res) {
  if (!res || res.ok === false) {
    const why = !res ? 'It could not be read.'
      : res.reason === 'outside' ? 'This file is outside the folders the preview can read (your home folder, the agent’s folder, temporary files).'
      : 'It is no longer there.';
    return '<div class="fp-msg">' + fpEsc(why) + '</div>';
  }
  const d = res;
  const text = typeof d.text === 'string' ? d.text : '';
  if (d.kind === 'image') return '<div class="fp-img"><img alt="' + fpEsc(d.name) + '" src="' + fpEsc(d.dataUrl || '') + '"></div>';
  if (d.kind === 'pdf') return '<iframe class="fp-frame fp-pdf" data-fp-pdf="1" title="' + fpEsc(d.name) + '"></iframe>';
  if (d.kind === 'other') return fpOtherHtml(d, d.note === 'too-large' ? 'too large to preview' : d.note === 'binary' ? 'no preview for this kind of file' : '');
  if (!text) return fpTruncNote(d) + '<div class="fp-msg">The file is empty.</div>';
  const source = FP.view === 'source';
  if (d.kind === 'html' && !source) {
    return fpTruncNote(d) + '<iframe class="fp-frame fp-html" data-fp-html="1" sandbox="" referrerpolicy="no-referrer" title="' + fpEsc(d.name) + '"></iframe>';
  }
  if (d.kind === 'markdown' && !source) return fpTruncNote(d) + fpMarkdownHtml(text);
  if ((d.kind === 'csv' || d.kind === 'tsv') && !source) return fpTruncNote(d) + fpTableHtml(text, d.kind === 'tsv' ? '\t' : fpCsvDelim(text));
  if (d.kind === 'code' || d.kind === 'html' || d.kind === 'markdown') return fpTruncNote(d) + fpCodeHtml(text, d.kind === 'markdown' ? 'md' : fpLangFor(d.ext));
  return fpTruncNote(d) + '<pre class="fp-text">' + fpEsc(text) + '</pre>';
}

/** Open or Reveal from the panel: the same checks the chip's own opener used. */
function fpOpenOutside(path) {
  const p = path || FP.path;
  const done = (r) => { if (r && r.ok === false && typeof toast === 'function') toast('Could not open', r.error || ''); };
  if (FP.reply && typeof openReplyPath === 'function') return openReplyPath(p).then(done);
  if (typeof openFilePath === 'function') return openFilePath(typeof homeDir === 'function' ? p.replace(/^~/, homeDir() || '~') : p).then(done);
  const br = fpBridge();
  return br && br.filePreviewAction ? br.filePreviewAction(p, 'open').then(done) : Promise.resolve();
}
function fpReveal() {
  const br = fpBridge();
  const p = FP.data && FP.data.ok ? FP.data.path : FP.path;
  if (br && br.filePreviewAction) br.filePreviewAction(p, 'reveal').then((r) => {
    if (r && r.ok === false && typeof toast === 'function') toast('Could not show it', r.reason === 'outside' ? 'It is outside the folders the preview can read.' : 'It is no longer there.');
  });
}

/* ---------------- width: dragged by the left edge, remembered per window ---------------- */
function fpStoredWidth() {
  try { const v = parseInt(localStorage.getItem(FP_WIDTH_KEY) || '', 10); return v > 0 ? v : 0; } catch (e) { return 0; }
}
function fpMaxWidth() {
  const main = typeof document !== 'undefined' ? document.getElementById('main') : null;
  return Math.max(FP_MIN_W, Math.round((main ? main.clientWidth : 1200) * 0.62));
}
function fpApplyWidth(w) {
  const el = fpEl();
  if (!el) return;
  const want = w || fpStoredWidth() || 440;
  el.style.width = Math.max(FP_MIN_W, Math.min(fpMaxWidth(), want)) + 'px';
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('#fpreview [data-fp]') : null;
    if (!b) return;
    const what = b.dataset.fp;
    if (what === 'resize') return;
    e.preventDefault(); e.stopPropagation();
    if (what === 'close') filePreviewClose();
    else if (what === 'refresh') { if (FP.open) fpLoad(true); }
    else if (what === 'open') fpOpenOutside();
    else if (what === 'reveal') fpReveal();
    else if (what === 'view') { FP.view = FP.view === 'source' ? 'render' : 'source'; fpPaintHead(); fpPaintBody(fpBodyHtml(FP.data)); }
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && FP.open && e.target && e.target.closest && e.target.closest('#fpreview')) { e.preventDefault(); filePreviewClose(); }
  });
  document.addEventListener('pointerdown', (e) => {
    const h = e.target && e.target.closest ? e.target.closest('#fpreview .fp-resize') : null;
    if (!h) return;
    e.preventDefault();
    const el = fpEl();
    const startX = e.clientX, startW = el.getBoundingClientRect().width;
    el.classList.add('fp-dragging');
    const move = (ev) => fpApplyWidth(startW + (startX - ev.clientX));
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      el.classList.remove('fp-dragging');
      try { localStorage.setItem(FP_WIDTH_KEY, String(Math.round(el.getBoundingClientRect().width))); } catch (err) { /* not kept */ }
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  });
  window.addEventListener('resize', () => { if (FP.open) fpApplyWidth(); });
}

if (typeof module !== 'undefined') module.exports = {parseDelimited, fpCsvDelim, fpFormatSize, fpHtmlDoc, fpLangFor, fpBodyHtml, FP_HTML_CSP};
