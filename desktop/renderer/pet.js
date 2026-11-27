/* ---------------- ATO-2391: the desktop pet's page ----------------
   Draws what main computes (main/pet-state.ts petView): the sprite's state
   as a class on <body>, and the bubble of the oldest approval request.
   Decides nothing about the agent: every answer goes to main (pet:answer),
   which checks it and hands it to the main window's own card.

   - Clicks go through the window except over the sprite and the bubble
     (BR.pet.hover tells main when the pointer is over one of them).
   - Drag the sprite to move it; a click opens the bubble again, or the
     main window; a right click opens the pet's menu.
   - Text only: every string from the agent goes in with textContent.

   The pure part is exported for the unit suite at the bottom. */

const PET_STATE_NAMES = ['waiting', 'error', 'working', 'thinking', 'done', 'idle', 'sleeping'];
const PET_DRAG_PX = 4;

/** The sprite's corner badge per state; do not disturb shows its moon instead. */
function petBadge(view) {
  if (!view) return '';
  if (view.dnd) return '☾';
  return {waiting: '!', sleeping: 'z', thinking: '…', error: '×', done: '✓'}[view.state] || '';
}

/**
 * What the bubble shows for `view`, given the requests the person put away
 * for now (`hidden`, approvalIds). Null: no bubble.
 */
function petBubbleModel(view, hidden) {
  const a = view && view.approval;
  if (!a || typeof a.approvalId !== 'string') return null;
  if (hidden && hidden.has(a.approvalId)) return null;
  const tool = String(a.tool || 'a tool');
  const inWindow = !a.canAllow && !a.question;
  return {
    approvalId: a.approvalId,
    title: a.question ? 'Atomic Agent has a question' : 'Allow ' + tool + '?',
    text: inWindow ? (a.text ? a.text + ' ' : '') + 'Review this one in Atomic Agent.' : String(a.text || ''),
    risk: String(a.risk || ''),
    allow: a.canAllow === true && !a.question,
    deny: !a.question,
    openLabel: a.question ? 'Answer in Atomic Agent' : inWindow ? 'Review' : 'Open',
    more: view.more > 0 ? view.more + ' more waiting' : '',
  };
}

/** The body's class list for a view: its state, and dnd. */
function petBodyClass(view) {
  const st = view && PET_STATE_NAMES.includes(view.state) ? view.state : 'idle';
  return 'pet st-' + st + (view && view.dnd ? ' dnd' : '');
}

function petBoot() {
  const BR = window.atomic && window.atomic.pet;
  if (!BR) return;
  const $ = (id) => document.getElementById(id);
  const sprite = $('pet');
  const bubble = $('bubble');
  const hidden = new Set();
  let view = null;
  let busy = null;   // approvalId whose answer is on its way
  let msg = '';

  const paint = () => {
    document.body.className = petBodyClass(view);
    const label = (view && view.label) || 'Atomic Agent';
    sprite.setAttribute('aria-label', label);
    sprite.title = label;
    $('badge').textContent = petBadge(view);
    const m = petBubbleModel(view, hidden);
    bubble.hidden = !m;
    if (!m) { msg = ''; return; }
    $('b-title').textContent = m.title;
    $('b-text').textContent = m.text;
    $('b-risk').textContent = m.risk;
    $('b-risk').hidden = !m.risk;
    $('b-msg').textContent = msg;
    $('b-msg').hidden = !msg;
    $('b-allow').hidden = !m.allow;
    $('b-deny').hidden = !m.deny;
    $('b-open').textContent = m.openLabel;
    $('b-more').textContent = m.more;
    $('b-more').hidden = !m.more;
    const sending = busy === m.approvalId;
    $('b-allow').disabled = sending;
    $('b-deny').disabled = sending;
  };

  const answer = (decision) => {
    const m = petBubbleModel(view, hidden);
    if (!m || busy) return;
    busy = m.approvalId;
    msg = 'Sending…';
    paint();
    BR.answer(m.approvalId, decision).then((res) => {
      busy = null;
      if (res && res.ok) { msg = ''; hidden.add(m.approvalId); }
      else msg = (res && res.error) || 'The answer did not go through. Open Atomic Agent to answer it.';
      paint();
    }, () => { busy = null; msg = 'The answer did not go through. Open Atomic Agent to answer it.'; paint(); });
  };

  $('b-allow').addEventListener('click', () => answer('allow'));
  $('b-deny').addEventListener('click', () => answer('deny'));
  $('b-open').addEventListener('click', () => BR.open());
  $('b-close').addEventListener('click', () => {
    const m = petBubbleModel(view, hidden);
    if (m) hidden.add(m.approvalId);
    paint();
  });

  /* Click-through: main ignores the mouse until the pointer is over the sprite or the bubble. */
  let drag = null;   // {x, y, moving, id} while the sprite is pressed
  let inside = false;
  const hover = (now) => { if (now !== inside) { inside = now; BR.hover(now); } };
  document.addEventListener('mousemove', (e) => hover(!!(e.target && e.target.closest && e.target.closest('.hit'))));
  document.addEventListener('mouseleave', () => { if (!drag) hover(false); });

  /* Drag the sprite; a press that did not move is a click. */
  sprite.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = {x: e.screenX, y: e.screenY, moving: false, id: e.pointerId};
    try { sprite.setPointerCapture(e.pointerId); } catch (err) { /* capture is a nicety */ }
  });
  sprite.addEventListener('pointermove', (e) => {
    if (!drag || drag.moving) return;
    if (Math.abs(e.screenX - drag.x) + Math.abs(e.screenY - drag.y) >= PET_DRAG_PX) { drag.moving = true; BR.drag('start'); }
  });
  const release = (clicked) => {
    if (!drag) return;
    const was = drag;
    drag = null;
    if (was.moving) { BR.drag('end'); return; }
    if (!clicked) return;
    const a = view && view.approval;
    if (a && hidden.has(a.approvalId)) { hidden.delete(a.approvalId); paint(); return; }
    BR.open();
  };
  sprite.addEventListener('pointerup', () => release(true));
  sprite.addEventListener('pointercancel', () => release(false));
  sprite.addEventListener('lostpointercapture', () => release(false));
  sprite.addEventListener('contextmenu', (e) => { e.preventDefault(); BR.menu(); });

  BR.onView((v) => {
    view = v && typeof v === 'object' ? v : null;
    // A request that is gone leaves the put-away set too.
    if (!view || !view.approval) hidden.clear();
    paint();
  });
  BR.attach().then((v) => { if (v && !view) { view = v; paint(); } }, () => {});
  paint();
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') petBoot();

if (typeof module !== 'undefined') module.exports = {petBadge, petBubbleModel, petBodyClass, PET_STATE_NAMES};
