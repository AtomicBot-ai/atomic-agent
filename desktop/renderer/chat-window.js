/* ---------------- ATO-1272 / ATO-1273: the transcript on screen is a window ----------------
   Loaded before renderer.js. S.log keeps the whole chat (it is what the rest
   of the window reads), but renderItems draws only its newest part: the last
   CHAT_WIN_TURNS questions and their answers, and never more than
   CHAT_WIN_ROWS rows that are actually drawn (a finished turn's folded steps
   do not count, they are one line). Everything earlier is one row at the top,
   "Show N earlier messages", which widens the window by one more step.

   Why: renderItems rebuilds the transcript's markup on every stream frame,
   so a chat that ran for hours re-rendered every reply's markdown 20-60 times
   a second, and every row stayed mounted. With the window the work per frame
   and the rows on screen stay bounded however long the chat gets.

   The window
   - never starts inside a finished turn's folded steps: it starts at that
     turn's question, so a summary line is never drawn without its turn;
   - does not move while you read: when the chat is not stuck to the bottom,
     the first row on screen stays where it is (rows only leave from the top
     while the view follows the newest reply);
   - goes back to its first size once the view is stuck to the bottom again,
     so rows opened with "Show earlier" are let go when you are back at the end;
   - starts over for every chat (a new S.log array).

   ATO-1273: the pictures still held in memory are the ones the window draws
   (chatImagesInUseOf); a picture of an earlier reply can leave the cache and is
   read from disk again when that reply comes back into the window. Beyond
   the size cap, only a few off-window pictures stay (chatImagesToDrop).

   The pure part is exported for test/chat-window.test.mjs. */

const CHAT_WIN_TURNS = 30;
const CHAT_WIN_ROWS = 300;
/* The window as it was last drawn. `log`: the S.log it was drawn for; `fromId`:
   the id of its first row, so it holds still while you read. */
const CHAT_WIN = {log: null, turns: CHAT_WIN_TURNS, rows: CHAT_WIN_ROWS, from: 0, fromId: null};

/** A non-steered question: where a turn begins. */
function chatWinTurnHead(m) {
  return !!m && m.k === 'user' && !m.steered;
}

/** The question row `at` belongs to (at or above it); 0 when there is none. */
function chatWinTurnHeadBefore(items, at) {
  for (let i = Math.min(at, items.length - 1); i >= 0; i--) if (chatWinTurnHead(items[i])) return i;
  return 0;
}

/**
 * The index of the first row the window draws.
 * opts: {turns, rows, folds (turnFoldsOf's Map), isOpen(fold), floor}
 * - counts back from the end until `turns` questions are in, or `rows` drawn
 *   rows (rows of a closed fold are not drawn, so they do not count);
 * - `floor`: an index the window must reach back to (the row on screen while
 *   you read, or one a jump asks for);
 * - a start inside a finished turn's steps moves back to that turn's question.
 */
function chatWindowStart(items, opts) {
  const o = opts || {};
  if (!Array.isArray(items) || !items.length) return 0;
  const turns = o.turns > 0 ? o.turns : CHAT_WIN_TURNS;
  const rows = o.rows > 0 ? o.rows : CHAT_WIN_ROWS;
  const folds = o.folds instanceof Map ? [...o.folds.values()] : [];
  const isOpen = typeof o.isOpen === 'function' ? o.isOpen : () => false;
  const hidden = new Set();
  for (const f of folds) if (!isOpen(f)) for (const x of f.rows) hidden.add(x);
  let start = items.length, heads = 0, drawn = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    if (!hidden.has(i)) {
      if (drawn >= rows) break;
      drawn++;
    }
    start = i;
    if (chatWinTurnHead(items[i]) && ++heads >= turns) break;
  }
  if (Number.isInteger(o.floor) && o.floor >= 0 && o.floor < start) start = o.floor;
  for (const f of folds) {
    if (!f.rows.length) continue;
    const head = chatWinTurnHeadBefore(items, f.rows[0]);
    if (head < start && start <= f.replyAt) start = head;
  }
  return start;
}

/**
 * The window for this paint, kept in CHAT_WIN. `stick`: the view follows the
 * newest reply (S.stick). Returns the first row to draw.
 */
function chatWindowFor(items, folds, isOpen, stick) {
  if (CHAT_WIN.log !== items) {
    CHAT_WIN.log = items;
    CHAT_WIN.turns = CHAT_WIN_TURNS; CHAT_WIN.rows = CHAT_WIN_ROWS;
    CHAT_WIN.from = 0; CHAT_WIN.fromId = null;
  } else if (stick) {
    // Back at the end: what "Show earlier" opened is let go.
    CHAT_WIN.turns = CHAT_WIN_TURNS; CHAT_WIN.rows = CHAT_WIN_ROWS;
    CHAT_WIN.fromId = null;
  }
  let floor = -1;
  if (!stick && CHAT_WIN.fromId != null) floor = items.findIndex((m) => m && m.id === CHAT_WIN.fromId);
  const from = chatWindowStart(items, {turns: CHAT_WIN.turns, rows: CHAT_WIN.rows, folds, isOpen, floor});
  CHAT_WIN.from = from;
  CHAT_WIN.fromId = from > 0 && items[from] ? items[from].id : null;
  return from;
}

/** "Show earlier": one more step of turns and rows. The caller repaints with the view held. */
function chatWindowMore() {
  CHAT_WIN.turns += CHAT_WIN_TURNS;
  CHAT_WIN.rows += CHAT_WIN_ROWS;
}

/**
 * Row `id` is above the window: reach back to it (a jump to a step, the
 * inspector's Steps). True when the window had to move; the caller sets
 * S.stick = false and repaints.
 */
function chatWindowReveal(items, id) {
  if (CHAT_WIN.log !== items) return false;
  const at = items.findIndex((m) => m && m.id === id);
  if (at < 0 || at >= CHAT_WIN.from) return false;
  CHAT_WIN.fromId = id;
  return true;
}

/** The row at the top of a window that does not start at the beginning. deps: {esc, ic}. */
function chatWindowMoreHTML(items, from, deps) {
  if (!(from > 0)) return '';
  const {esc, ic} = deps;
  let said = 0;
  for (let i = 0; i < from && i < items.length; i++) {
    const m = items[i];
    if (m && (m.k === 'user' || m.k === 'assistant')) said++;
  }
  const label = said ? 'Show ' + said + ' earlier message' + (said === 1 ? '' : 's') : 'Show earlier steps';
  return '<div class="turn tk-step chatwin-more" id="chatwin-more"><div></div><div>'
    + '<button class="btn btn-g xs" data-chatwin="more" title="Earlier parts of this chat are not drawn, to keep the window fast">'
    + ic('up') + '<span>' + esc(label) + '</span></button></div></div>';
}

/** ATO-1273: the pictures the rows from `from` on show; the rest may leave the image cache. */
function chatImagesInUseOf(items, from) {
  const used = new Set();
  if (!Array.isArray(items)) return used;
  for (let i = Math.max(0, from | 0); i < items.length; i++) {
    const m = items[i];
    if (!m) continue;
    for (const p of (m.replyFiles || [])) used.add(p);
    for (const p of (m.turnPics || [])) used.add(p);   // ATO-1258
    if (m.shotPic) used.add(m.shotPic);
  }
  return used;
}

/**
 * ATO-1273: which read pictures leave the cache. `held`: [path, {url, used}]
 * of the pictures read; `inUse`: the paths the window draws (never dropped).
 * Off-window pictures go, least recently drawn first, until the display
 * copies fit in `keepChars` and at most `keepOff` off-window pictures remain.
 */
function chatImagesToDrop(held, inUse, keepChars, keepOff) {
  const list = Array.isArray(held) ? held.slice() : [];
  const used = inUse instanceof Set ? inUse : new Set();
  let total = 0, off = 0;
  for (const [p, st] of list) { total += (st.url || '').length; if (!used.has(p)) off++; }
  const out = [];
  if (total <= keepChars && off <= keepOff) return out;
  list.sort((a, b) => (used.has(a[0]) - used.has(b[0])) || ((a[1].used || 0) - (b[1].used || 0)));
  for (const [p, st] of list) {
    if (total <= keepChars && off <= keepOff) break;
    if (used.has(p)) break;
    total -= (st.url || '').length;
    off--;
    out.push(p);
  }
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {CHAT_WIN, CHAT_WIN_TURNS, CHAT_WIN_ROWS, chatWindowStart, chatWindowFor, chatWindowMore,
    chatWindowReveal, chatWindowMoreHTML, chatImagesInUseOf, chatImagesToDrop};
}
