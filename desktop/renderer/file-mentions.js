/* ATO-1596 / ATO-1597: @-file mentions in the composer, the desktop side of
   the terminal's src/tui/file-mentions (PR #1428).

   ATO-1596: typing `@word` at the start of the box or after a space opens a
   list of the working folder's files (BR.mentionsSearch, main lists them);
   ↑↓ move, Tab / Enter put `@path ` in the box, Esc closes. The menu hangs
   off `.composerwrap` like the slash list, because `#composer` clips.
   Main reads the files and appends the `<mentioned-files>` block itself.

   ATO-1597: a sent message carries that block after the typed text. The chat
   shows the typed text and one line per file instead (collapseMentionedFiles
   on the terminal side), and "send again" / rollback put back the typed text
   only, so main expands the mentions once more instead of twice.

   ATO-2751: `@diff`, `@git:N`, ranges and links are rows too (mention-rows.js);
   "Searching…" and "Couldn't search files" are rows; Enter sends when there is
   nothing to pick; a skipped mention's line says why.

   renderer.js calls fmOnInput, fmKeydown, fmAccept and fmMenuHTML; the pure
   helpers at the top are what the node tests load. */

/* ---------- the `@` under the caret (mention-query.ts) ---------- */

/* A mention starts at the start of the text or after whitespace, so
   `me@site.com` never opens the list. */
const FM_TRAILING = /(^|\s)@([^\s@]*)$/;

/**
 * The mention the caret sits in: `{start, end, query}`, where `start` is the
 * index of the `@`, `end` the end of the token (it may run past the caret),
 * and `query` what is typed between the `@` and the caret. Null when none.
 */
function fmActiveMention(text, caret) {
  const s = String(text == null ? '' : text);
  const at = typeof caret === 'number' && caret >= 0 && caret <= s.length ? caret : s.length;
  const m = FM_TRAILING.exec(s.slice(0, at));
  if (!m) return null;
  const start = m.index + (m[1] || '').length;
  const rest = /^[^\s@]*/.exec(s.slice(at));
  return {start, end: at + (rest ? rest[0].length : 0), query: m[2] || ''};
}

/**
 * The text with the mention replaced by `@path ` and where the caret goes
 * (just past the space). A space that already follows the token is reused,
 * so picking in the middle of a sentence leaves one space, not two.
 */
function fmInsertPath(text, mention, path) {
  const s = String(text == null ? '' : text);
  const head = s.slice(0, mention.start);
  const tail = s.slice(mention.end);
  const sep = /^\s/.test(tail) ? '' : ' ';
  const out = head + '@' + path + sep + tail;
  return {text: out, caret: head.length + 1 + String(path).length + 1};
}

/* ---------- the block a sent message carries (mention-block.ts) ---------- */

const FM_BLOCK_OPEN = '<mentioned-files>';
const FM_BLOCK_CLOSE = '</mentioned-files>';
const FM_SEPARATOR = '\n\n' + FM_BLOCK_OPEN + '\nFiles the user referenced with @, read from the working directory:\n';
/* describeMentionedFile: `src/app.ts (4 KB)`, `(4 KB, truncated to the first 2 KB)`,
   `(4 KB, not inlined: binary file)`. */
const FM_SUMMARY_LINE = /^(.+) \((\d+(?:\.\d+)? (?:B|KB|MB))(?:, (.+))?\)$/;

/**
 * A message with a `<mentioned-files>` block, taken apart:
 * `{typed, files:[{path, size, note, skipped?}]}`, `note` being '',
 * 'truncated' or, for a mention that was not inlined, the reason in words
 * (`skipped: true`). Null when the message has no block this format wrote.
 */
function fmSplitBlock(message) {
  const s = String(message == null ? '' : message);
  const at = s.indexOf(FM_SEPARATOR);
  if (at < 0) return null;
  const close = s.lastIndexOf(FM_BLOCK_CLOSE);
  if (close < at) return null;
  const files = [];
  for (const line of s.slice(at + FM_SEPARATOR.length).split('\n')) {
    if (!line.startsWith('- ')) break;
    const item = line.slice(2);
    const m = FM_SUMMARY_LINE.exec(item);
    if (!m) { files.push({path: item, size: '', note: ''}); continue; }
    const extra = m[3] || '';
    const skip = /^not inlined(?:: (.+))?$/.exec(extra);
    if (skip) {
      const say = typeof mrSkipReason === 'function' ? mrSkipReason : (r) => r || 'skipped';
      files.push({path: m[1], size: m[2], note: say(skip[1] || ''), skipped: true});
      continue;
    }
    files.push({path: m[1], size: m[2], note: /^truncated\b/.test(extra) ? 'truncated' : ''});
  }
  // Whatever follows the block (another block a later step appended) stays.
  return {typed: s.slice(0, at) + s.slice(close + FM_BLOCK_CLOSE.length), files};
}

/** The message as typed, without the block: what "send again" and rollback put back. */
function fmTypedText(message) {
  const split = fmSplitBlock(message);
  return split ? split.typed : String(message == null ? '' : message);
}

/**
 * One line per file: `@src/app.ts · 4 KB`, `@big.log · 2.0 MB · truncated`,
 * `@diff · skipped: not a git checkout, or git failed` (a skipped mention's
 * "0 B" says nothing, so it is left out).
 */
function fmFileLine(file) {
  const size = file.size && !(file.skipped && file.size === '0 B') ? ' · ' + file.size : '';
  const note = file.note ? ' · ' + (file.skipped ? 'skipped: ' : '') + file.note : '';
  return '@' + file.path + size + note;
}

/** The typed text and a line per file, as plain text (collapseMentionedFiles). */
function fmCollapse(message) {
  const split = fmSplitBlock(message);
  if (!split) return String(message == null ? '' : message);
  return [split.typed].concat(split.files.map(fmFileLine)).join('\n');
}

function fmEsc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
}

/** The lines under a sent bubble, in the steered caption's style. */
function fmSentHTML(files) {
  return (files || []).map((f) => '<div class="usrcap fmsent" title="' + fmEsc(fmFileLine(f)) + '">' + fmEsc(fmFileLine(f)) + '</div>').join('');
}

/* ---------- the menu (renderer only) ---------- */

const FM_DEBOUNCE_MS = 80;
const FM_MAX_ROWS = 50;
const FM_WAIT_MS = 250;   // a search slower than this shows "Searching…"; a quick one never flashes it
/* files: null until the first answer for this mention; kinds: the rows read
   from the typed text (mention-rows.js); status: 'searching' | 'ready' | 'failed'. */
const FM = {open: false, start: -1, end: -1, query: '', files: null, kinds: [], status: 'ready', slow: false,
  cur: 0, seq: 0, timer: null, waitTimer: null, dismissed: -1};

/** What can be picked: the kind rows, then the files, each once. */
function fmRows() {
  if (typeof mrMerge === 'function') return mrMerge(FM.kinds, FM.files || [], FM_MAX_ROWS);
  return (FM.files || []).slice(0, FM_MAX_ROWS);
}
/** The bridge is there and the agent is this machine's (a remote one has no folder to list). */
function fmAvailable() {
  if (typeof BR === 'undefined' || !BR || typeof BR.mentionsSearch !== 'function') return false;
  if (typeof ProjectModels !== 'undefined' && ProjectModels && ProjectModels.state && ProjectModels.state.remote) return false;
  return true;
}
function fmSessionId() {
  if (typeof skillSessionId === 'function') return skillSessionId();
  if (typeof S === 'undefined') return null;
  return S.sessionId || S.agentSession || null;
}
/* The same gates as the slash list, plus: the draft still has its `@` where
   the mention began (a sent or cleared box shows nothing), and there is
   something to say (rows, an answer, a slow search or a failed one). */
function fmShown() {
  if (!FM.open || typeof S === 'undefined') return false;
  if (FM.files === null && !FM.kinds.length && !FM.slow && FM.status !== 'failed') return false;
  if (S.slash || S.overlay || S.settings || S.alert) return false;
  if (typeof SEL !== 'undefined' && SEL && SEL.open) return false;
  return String(S.draft || '').charAt(FM.start) === '@';
}

/** A row that cannot be picked: "Searching…", "Couldn't search files", "No matching files". */
const fmStateRow = (kind, text) => '<div class="slashrow nomatch fmstate fm-' + kind + '" role="status"><span class="cmd">' + text + '</span></div>';

function fmMenuHTML() {
  if (!fmShown()) return '';
  const rows = fmRows();
  const state = FM.status === 'failed' ? fmStateRow('failed', 'Couldn’t search files')
    : FM.status === 'searching' && FM.files === null ? (FM.slow ? fmStateRow('wait', 'Searching…') : '')
      : rows.length ? '' : fmStateRow('none', 'No matching files');
  const q = FM.query;
  const mark = (p) => typeof bold === 'function' ? bold(p, q) : fmEsc(p);
  const hint = (p) => { const h = typeof mrRowHint === 'function' ? mrRowHint(p) : ''; return h ? '<span class="ds">' + fmEsc(h) + '</span>' : ''; };
  const list = rows.map((p, i) =>
    '<button class="slashrow fmrow' + (i === FM.cur ? ' on' : '') + '" role="option" aria-selected="' + (i === FM.cur) + '" data-fm-row="' + i + '" title="' + fmEsc(p) + '">'
    + '<span class="cmd">@' + mark(p) + '</span>' + hint(p) + '</button>').join('');
  const foot = rows.length
    ? '<div class="slashfoot"><span>' + rows.length + (rows.length === 1 ? ' match' : ' matches') + '</span>'
      + '<span class="grow"></span>' + (typeof keycaps === 'function' ? keycaps('↑↓ tab esc') : '') + '</div>'
    : '';
  return '<div class="fmmenu"' + (rows.length ? ' role="listbox" aria-label="Files"' : '') + '><div class="slashlist">' + list + state + '</div>' + foot + '</div>';
}

/* In place, like refreshSlash: a render() here would reset the box and move the caret. */
function fmPaint() {
  if (typeof document === 'undefined') return;
  const wrap = document.querySelector('.composerwrap'); if (!wrap) return;
  const old = wrap.querySelector('.fmmenu'); if (old) old.remove();
  const html = fmMenuHTML(); if (!html) return;
  const composer = wrap.querySelector('#composer');
  if (composer) composer.insertAdjacentHTML('beforebegin', html);
  else wrap.insertAdjacentHTML('beforeend', html);
  const on = wrap.querySelector('.fmmenu .fmrow.on');
  if (on && on.scrollIntoView) on.scrollIntoView({block: 'nearest'});
}

function fmClose() {
  FM.open = false; FM.files = null; FM.kinds = []; FM.status = 'ready'; FM.slow = false; FM.cur = 0; FM.seq++;
  clearTimeout(FM.timer); clearTimeout(FM.waitTimer); FM.timer = FM.waitTimer = null;
  fmPaint();
}

async function fmSearch() {
  FM.timer = null;
  const q = FM.query, seq = ++FM.seq;
  let r = null;
  try { r = await BR.mentionsSearch(fmSessionId(), q); } catch (err) { r = {ok: false, error: String((err && err.message) || err)}; }
  if (seq !== FM.seq || !FM.open || FM.query !== q) return;   // a newer keystroke owns the list
  clearTimeout(FM.waitTimer); FM.waitTimer = null;
  if (!r || !r.ok || !Array.isArray(r.paths)) {
    // The kind rows stay pickable; the failure is a row, not a menu that vanishes.
    if (typeof console !== 'undefined') console.warn('[mentions] search failed:', r && r.error);
    FM.files = null; FM.status = 'failed';
  } else {
    FM.files = r.paths.filter((p) => typeof p === 'string' && p);
    FM.status = r.filesError ? 'failed' : 'ready';   // main's words came back, its file listing did not
  }
  FM.cur = 0;
  fmPaint();
}

/** The composer's input: open, follow or close the list. */
function fmOnInput(entry) {
  if (!entry || !fmAvailable() || String(entry.value || '').startsWith('/')) { if (FM.open) fmClose(); return; }
  const m = fmActiveMention(entry.value, entry.selectionStart);
  if (!m) { FM.dismissed = -1; if (FM.open) fmClose(); return; }
  if (m.start === FM.dismissed) return;   // Esc closed this one; another `@` opens again
  const opening = !FM.open || m.start !== FM.start;
  const changed = opening || m.query !== FM.query;
  FM.open = true; FM.start = m.start; FM.end = m.end;
  if (changed) {
    FM.query = m.query;
    FM.kinds = typeof mrKindRows === 'function' ? mrKindRows(m.query) : [];
    FM.status = 'searching'; FM.cur = 0;
    if (opening) {
      FM.files = null; FM.slow = false; clearTimeout(FM.waitTimer);
      FM.waitTimer = setTimeout(() => { FM.waitTimer = null; FM.slow = true; fmPaint(); }, FM_WAIT_MS);
    }
    clearTimeout(FM.timer); FM.timer = setTimeout(fmSearch, FM_DEBOUNCE_MS);
  }
  fmPaint();
}

/** Put row `i` in the box as `@path `. */
function fmAccept(i) {
  const path = fmRows()[i];
  if (!path) return;
  const e = typeof document !== 'undefined' ? document.getElementById('entry') : null;
  const value = e ? e.value : String(S.draft || '');
  const at = fmActiveMention(value, e ? e.selectionStart : value.length);
  const mention = at && at.start === FM.start ? at : {start: FM.start, end: FM.end};
  const r = fmInsertPath(value, mention, path);
  S.draft = r.text;
  FM.dismissed = -1;
  fmClose();
  if (e) {
    e.value = r.text;
    e.focus();
    try { e.setSelectionRange(r.caret, r.caret); } catch (err) {}
    if (typeof autosize === 'function') autosize(e);
  }
  if (typeof ctxDraftChanged === 'function') ctxDraftChanged();
  if (typeof refreshSend === 'function') refreshSend();
}

/**
 * The composer's keys while the list is on screen; true when the key was the
 * list's. Enter is the composer's (it sends) when there is nothing to pick,
 * or when the token is already exactly the row Enter would put in.
 */
function fmKeydown(e) {
  if (!e || e.isComposing || e.keyCode === 229) return false;   // the IME's key (ATO-822)
  if (!e.target || e.target.id !== 'entry' || !fmShown()) return false;
  const k = e.key, rows = fmRows(), n = rows.length;
  if (k === 'Escape') { e.preventDefault(); FM.dismissed = FM.start; fmClose(); return true; }
  if (k === 'ArrowDown' && n) { e.preventDefault(); FM.cur = Math.min(FM.cur + 1, n - 1); fmPaint(); return true; }
  if (k === 'ArrowUp' && n) { e.preventDefault(); FM.cur = Math.max(FM.cur - 1, 0); fmPaint(); return true; }
  if (k === 'Enter' && !e.shiftKey && !e.altKey && (!n || rows[FM.cur] === FM.query)) {
    FM.dismissed = FM.start; fmClose();
    return false;   // renderer.js goes on to submit()
  }
  if ((k === 'Tab' && !e.shiftKey) || (k === 'Enter' && !e.shiftKey && !e.altKey)) {
    e.preventDefault();
    if (n) fmAccept(FM.cur);
    else { FM.dismissed = FM.start; fmClose(); }
    return true;
  }
  return false;
}

if (typeof module !== 'undefined') {
  module.exports = {fmActiveMention, fmInsertPath, fmSplitBlock, fmTypedText, fmFileLine, fmCollapse, fmSentHTML,
    FM_BLOCK_OPEN, FM_BLOCK_CLOSE, FM_SEPARATOR};
}
