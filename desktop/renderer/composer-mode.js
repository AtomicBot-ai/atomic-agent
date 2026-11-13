/* ---------------- W2: the composer's mode chip ----------------
   One chip in the row under the input, beside the permission chip ("Ask
   first"), the way Claude and Codex show a mode picker. It reads the mode the
   chat is in and opens a short menu of four:

     Chat               the default: a message, a reply
     Goal               the goal form and card (goal-card.js, goal-actions.js)
     Run overnight      the long-task dialog (overnight.js)
     Voice conversation listen, send, read the reply aloud (converse.js)

   Nothing here is a new flow: each row starts the one that already exists.
   They used to be three buttons of their own (a flag and a window beside "+",
   a speaker beside the mic) and a row in the "+" menu, which the owner found
   confusing: "+" now holds attachments only.

   Loaded after goal-card.js, converse.js and overnight.js; their globals
   (GOAL_FORM, goalOf, goalFormShow, CONV, convToggle, ovnOpen) and the
   renderer's (S, BR, render) are read only when a function runs. The menu
   hangs off `.composerwrap` like the "+" menu (`.composer` clips), and is
   always emitted, hidden while closed, so opening it needs no render(). */

const CMODE = {open: false};

/** The rows, in order. `voice` is left out where dictation does not exist (BR.voiceSupported false). */
const CMODE_ROWS = [
  {id: 'chat', word: 'Chat', icon: 'chat', hint: 'Ask, and get a reply'},
  {id: 'goal', word: 'Goal', icon: 'flag', hint: 'Keeps working until every item on your list is met'},
  {id: 'overnight', word: 'Run overnight', icon: 'moon', hint: 'One long task with a time limit and a budget'},
  {id: 'voice', word: 'Voice conversation', icon: 'speak', hint: 'Speak, hear the reply, speak again · ⇧⌘J'},
];

/* ---------- pure ---------- */

/**
 * The mode on screen, from what the flows hold: a conversation running wins,
 * then a goal (its form open, or a goal on this chat that is still going),
 * else Chat. Run overnight is a dialog that hands the task off, so it is
 * never the chat's own mode.
 * st: {conv, goalFormOpen, goalStatus}
 */
function cmodeCurrent(st) {
  if (st && st.conv && st.conv !== 'off') return 'voice';
  if (st && (st.goalFormOpen || st.goalStatus === 'active')) return 'goal';
  return 'chat';
}
/** The rows the menu offers: no Voice conversation without dictation. */
function cmodeRows(voiceSupported) {
  return CMODE_ROWS.filter((r) => r.id !== 'voice' || voiceSupported !== false);
}

/* ---------- reading the flows ---------- */

function cmodeState() {
  let conv = 'off', goalFormOpen = false, goalStatus = null;
  try { if (typeof CONV !== 'undefined') conv = CONV.state; } catch (e) { /* no conversation mode */ }
  try { if (typeof GOAL_FORM !== 'undefined') goalFormOpen = !!GOAL_FORM.open; } catch (e) { /* no goals */ }
  try {
    if (typeof goalOf === 'function' && typeof S !== 'undefined') {
      const g = goalOf(S.sessionId);
      goalStatus = g ? g.status : null;
    }
  } catch (e) { /* no goal on this chat */ }
  return {conv, goalFormOpen, goalStatus};
}
function cmodeVoiceSupported() {
  return !(typeof BR === 'undefined' || !BR || BR.voiceSupported === false);
}

/* ---------- markup ---------- */

/** The chip. `data-conv` keeps a click on it from ending a running conversation before the menu opens. */
function cmodePickChipHTML(deps) {
  const {esc, ic} = deps;
  const cur = cmodeCurrent(cmodeState());
  const row = CMODE_ROWS.find((r) => r.id === cur) || CMODE_ROWS[0];
  const word = cur === 'voice' ? 'Voice' : row.word;
  return '<button class="cchip cmodepick' + (cur !== 'chat' ? ' is-' + cur : '') + (CMODE.open ? ' is-open' : '') + '"'
    + ' data-cmode-open="1" data-conv="1" data-id="' + esc(cur) + '"'
    + ' aria-haspopup="menu" aria-expanded="' + (CMODE.open ? 'true' : 'false') + '"'
    + ' title="Mode: ' + esc(row.word) + '" aria-label="Mode: ' + esc(row.word) + '">'
    + ic(row.icon) + '<span class="cval">' + esc(word) + '</span>' + ic('chevD', 'chev') + '</button>';
}
/** The menu: a titled list of rows, each with its one-line hint under the label. */
function cmodeMenuHTML(deps) {
  const {esc, ic} = deps;
  const cur = cmodeCurrent(cmodeState());
  return '<div class="cmodemenu" id="cmodemenu" role="menu" aria-label="Mode"' + (CMODE.open ? '' : ' hidden') + '>'
    + cmodeRows(cmodeVoiceSupported()).map((r) =>
      '<button class="cmoderow' + (r.id === cur ? ' on' : '') + '" role="menuitemradio" aria-checked="' + (r.id === cur ? 'true' : 'false') + '"'
        + ' data-cmode="' + r.id + '" data-conv="1">'
        + '<span class="cmodeic">' + ic(r.icon) + '</span>'
        + '<span class="col"><span class="ml">' + esc(r.word) + '</span><span class="cap">' + esc(r.hint) + '</span></span>'
        + '<span class="cmodeck">' + (r.id === cur ? ic('check') : '') + '</span></button>').join('')
    + '</div>';
}

/* ---------- flow ---------- */

/** Opens or closes the menu in place, under the chip, without a render(). */
function cmodeRepaint() {
  if (typeof document === 'undefined') return;
  const menu = document.getElementById('cmodemenu');
  const chip = document.querySelector('#composer .cmodepick');
  if (chip) { chip.classList.toggle('is-open', CMODE.open); chip.setAttribute('aria-expanded', CMODE.open ? 'true' : 'false'); }
  if (!menu) return;
  menu.hidden = !CMODE.open;
  if (!CMODE.open || !chip) return;
  const wrap = menu.parentElement;
  const wr = wrap ? wrap.getBoundingClientRect() : {left: 0, top: 0, width: window.innerWidth};
  const cr = chip.getBoundingClientRect();
  const w = menu.offsetWidth || 300;
  const left = Math.max(0, Math.min(cr.right - wr.left - w, wr.width - w));
  menu.style.left = Math.round(left) + 'px';
  menu.style.bottom = Math.round(wr.top + wrap.offsetHeight - cr.top + 6) + 'px';
  const on = menu.querySelector('.cmoderow.on') || menu.querySelector('.cmoderow');
  if (on) on.focus();
}
function cmodeClose() { if (!CMODE.open) return; CMODE.open = false; cmodeRepaint(); }

/** A row was picked: leave the mode the chat is in, then start the chosen one's own flow. */
function cmodePick(id) {
  CMODE.open = false;
  cmodeRepaint();
  const st = cmodeState();
  const convOn = st.conv && st.conv !== 'off';
  if (id !== 'voice' && convOn && typeof convToggle === 'function') convToggle();
  if (id !== 'goal' && st.goalFormOpen && typeof goalFormShow === 'function') goalFormShow(false);
  if (id === 'goal') { if (!st.goalFormOpen && typeof goalFormShow === 'function') goalFormShow(true); return; }
  if (id === 'overnight') { if (typeof ovnOpen === 'function') void ovnOpen(); return; }
  if (id === 'voice') { if (!convOn && typeof convToggle === 'function') convToggle(); return; }
  if (typeof render === 'function') render();
  const e = typeof $ === 'function' ? $('#entry') : null;
  if (e) e.focus();
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('[data-cmode-open]')) { e.preventDefault(); CMODE.open = !CMODE.open; cmodeRepaint(); return; }
    const row = t.closest('[data-cmode]');
    if (row) { e.preventDefault(); cmodePick(row.getAttribute('data-cmode')); return; }
    if (CMODE.open && !t.closest('#cmodemenu')) cmodeClose();
  });
  document.addEventListener('keydown', (e) => {
    if (!CMODE.open) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cmodeClose(); const c = document.querySelector('#composer .cmodepick'); if (c) c.focus(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const rows = Array.from(document.querySelectorAll('#cmodemenu .cmoderow'));
      if (!rows.length) return;
      e.preventDefault();
      const i = rows.indexOf(document.activeElement);
      const n = e.key === 'ArrowDown' ? (i + 1) % rows.length : (i <= 0 ? rows.length - 1 : i - 1);
      rows[n].focus();
    }
  }, true);
}

if (typeof module !== 'undefined') {
  module.exports = {CMODE, CMODE_ROWS, cmodeCurrent, cmodeRows, cmodePickChipHTML, cmodeMenuHTML};
}
