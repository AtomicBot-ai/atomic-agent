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
    text: String(a.text || ''),
    detail: inWindow ? (a.detail ? a.detail + ' ' : '') + 'Review this one in Atomic Agent.' : String(a.detail || ''),
    risk: String(a.risk || ''),
    allow: a.canAllow === true && !a.question,
    deny: !a.question,
    openLabel: a.question ? 'Answer in Atomic Agent' : inWindow ? 'Review' : 'Open',
    more: view.more > 0 ? view.more + ' more waiting' : '',
    keys: petKeysLine(a.canAllow === true && !a.question, !a.question, view.more),
  };
}

/* ATO-2513: the bubble from the keyboard. A click on the bubble or the
   sprite lets the pet window take the keyboard (pet:focus); Tab moves
   between the buttons, Enter is Allow once (on a focused button: that
   button), Esc is Deny (Hide for a question, which the bubble never
   answers). The line under the buttons says so while the bubble has focus. */

/** The hint shown while the bubble has the keyboard. */
function petKeysLine(allow, deny, more) {
  const parts = [];
  if (allow) parts.push('Enter: Allow once');
  parts.push(deny ? 'Esc: Deny' : 'Esc: Hide');
  if (more > 0) parts.push(more + ' more waiting');
  return parts.join(' \u00b7 ');
}

/**
 * What a key does in the bubble: 'allow', 'deny', 'hide', or null (let
 * the focused button take it). `focused` is the id of the focused element.
 */
function petBubbleKey(key, model, focused) {
  if (!model) return null;
  if (key === 'Escape') return model.deny ? 'deny' : 'hide';
  if (key !== 'Enter') return null;
  // A focused button other than Allow does its own job on Enter.
  if (focused && focused !== 'b-allow' && /^b-/.test(focused)) return null;
  return model.allow ? 'allow' : null;
}

/** The button the keyboard lands on: Allow once, else Deny, else Open. */
function petFirstButton(model) {
  if (!model) return null;
  return model.allow ? 'b-allow' : model.deny ? 'b-deny' : 'b-open';
}

/* ATO-2513: a pet the person made. Four pictures cover the seven states,
   as main/pet-skins.ts petSkinFrame maps them. */
const PET_SKIN_FRAME = {working: 'working', thinking: 'working', waiting: 'waiting', error: 'waiting', sleeping: 'sleeping'};

/** The picture for `state` from a made pet's frames, or null (the built-in atom). */
function petSkinSrc(frames, state) {
  if (!frames || typeof frames !== 'object') return null;
  const src = frames[PET_SKIN_FRAME[state] || 'idle'];
  return typeof src === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(src) ? src : null;
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
  let skin = null;        // ATO-2513: a made pet's frames, or null for the atom
  let keyboard = false;   // ATO-2513: the pet window has the keyboard
  const takeKeys = () => { if (!keyboard && BR.focus) { keyboard = true; BR.focus(true); } };
  const dropKeys = () => { if (keyboard && BR.focus) { keyboard = false; BR.focus(false); } };

  const paint = () => {
    const src = petSkinSrc(skin, view ? view.state : 'idle');
    document.body.className = petBodyClass(view) + (src ? ' has-skin' : '');
    const img = $('skin');
    if (img) { img.hidden = !src; if (src && img.getAttribute('src') !== src) img.src = src; }
    const label = (view && view.label) || 'Atomic Agent';
    sprite.setAttribute('aria-label', label);
    sprite.title = label;
    $('badge').textContent = petBadge(view);
    const m = petBubbleModel(view, hidden);
    bubble.hidden = !m;
    // ATO-2513: no bubble, no keyboard: the window goes back to never taking it.
    if (!m) { msg = ''; dropKeys(); return; }
    $('b-title').textContent = m.title;
    $('b-text').textContent = m.text;
    $('b-detail').textContent = m.detail;
    $('b-detail').hidden = !m.detail;
    $('b-risk').textContent = m.risk;
    $('b-risk').hidden = !m.risk;
    $('b-msg').textContent = msg;
    $('b-msg').hidden = !msg;
    $('b-allow').hidden = !m.allow;
    $('b-deny').hidden = !m.deny;
    $('b-open').textContent = m.openLabel;
    $('b-more').textContent = m.more;
    $('b-more').hidden = !m.more;
    $('b-keys').textContent = m.keys;
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
  const hide = () => {
    const m = petBubbleModel(view, hidden);
    if (m) hidden.add(m.approvalId);
    paint();
  };
  $('b-close').addEventListener('click', hide);

  /* ATO-2513: the keyboard; main lets the window take it only after a click here. */
  bubble.addEventListener('pointerdown', takeKeys);
  window.addEventListener('focus', () => {
    const m = petBubbleModel(view, hidden);
    if (!m || bubble.contains(document.activeElement)) return;
    const id = petFirstButton(m);
    if (id && $(id)) $(id).focus();
  });
  window.addEventListener('blur', () => { keyboard = false; });
  document.addEventListener('keydown', (e) => {
    const m = petBubbleModel(view, hidden);
    const act = petBubbleKey(e.key, m, document.activeElement && document.activeElement.id);
    if (!act) return;
    e.preventDefault();
    if (act === 'allow') answer('allow');
    else if (act === 'deny') answer('deny');
    else hide();
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
    if (petBubbleModel(view, hidden)) takeKeys();
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
  if (BR.onSkin) BR.onSkin((frames) => { skin = frames && typeof frames === 'object' ? frames : null; paint(); });
  if (BR.skin) BR.skin().then((frames) => { skin = frames && typeof frames === 'object' ? frames : null; paint(); }, () => {});
  paint();
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') petBoot();

if (typeof module !== 'undefined') module.exports = {petBadge, petBubbleModel, petBodyClass, petBubbleKey, petFirstButton, petKeysLine, petSkinSrc, PET_STATE_NAMES};
