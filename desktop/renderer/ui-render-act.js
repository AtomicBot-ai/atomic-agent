/* ---------------- ATO-2457: clicks and typing in ui.render cards ----------------
   ui-render.js draws the cards; this file reads what the person does in
   them. A card's box is kept across repaints (data-morph-keep), so a
   change here updates the box in place and the state in UIR, which a full
   redraw reads.

   - a decision's option or a card's action: its message goes to widgetDeliver
     (widget-send.js), and the clicked one is marked;
   - a form: each field's value is kept as it is typed; Send (or Enter in a
     one-line field) checks the required fields, then delivers the
     "Label: value" lines. The form stays, so it can be changed and sent again.

   Capture phase, as canvas-pane.js: renderer.js's own click and key
   handling in a reply should not also run for these.

   Loaded after ui-render.js and widget-send.js. Pure part exported for
   test/ui-render.test.mjs. */

/** Hand a card's message on; answers what happened ('filled' | 'sent' | 'draft' | 'none'). */
function uirDeliver(text, title) {
  if (typeof widgetDeliver === 'function') return widgetDeliver(text, title);
  if (typeof abFillComposer === 'function') return abFillComposer(text, title);
  return 'none';
}

/** Redraw one card's box in place (it is kept across repaints, so nothing else will). */
function uirRepaint(key, keepFocus) {
  if (typeof document === 'undefined') return;
  const st = UIR.get(key);
  const box = st && document.querySelector('[data-uir="' + uirEsc(key) + '"]');
  if (!box) return;
  const active = document.activeElement;
  const focusId = keepFocus && active && box.contains(active) ? active.id : '';
  box.innerHTML = uirBodyHTML(st);
  if (focusId) { const again = document.getElementById(focusId); if (again) again.focus(); }
}

/** The person acted on a card: `what` is {opt: i} | {card: i} | {submit: true}. Answers the delivery result. */
function uirAct(key, what) {
  const st = UIR.get(key);
  if (!st) return 'none';
  if (what.submit) {
    const missing = uirMissing(st);
    if (missing.length) {
      st.err = 'Fill in ' + missing.join(', ') + ' first.';
      return 'none';
    }
  }
  const index = what.submit ? -1 : Number(what.opt != null ? what.opt : what.card);
  const text = uirMessage(st, index);
  if (!text) { st.err = what.submit ? 'Fill in at least one field first.' : ''; return 'none'; }
  const r = uirDeliver(text, st.spec.title);
  st.err = '';
  if (r === 'filled' || r === 'sent') {
    if (!what.submit) st.chosen = index;
    st.sent = r === 'sent' ? 'Sent to the agent.' : 'In your message box: press Enter to send.';
  }
  return r;
}

/** A field's new value, kept for this card. */
function uirInput(key, name, value) {
  const st = UIR.get(key);
  if (!st || !(name in st.values)) return false;
  st.values[name] = String(value).slice(0, 2000);
  if (st.err) st.err = '';
  return true;
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const t = e.target && e.target.closest ? e.target : null;
    const box = t && t.closest('[data-uir]');
    if (!box) return;
    const b = t.closest('[data-uir-opt], [data-uir-card], [data-uir-submit]');
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    const key = box.dataset.uir;
    const what = b.dataset.uirSubmit ? {submit: true} : b.dataset.uirOpt != null ? {opt: b.dataset.uirOpt} : {card: b.dataset.uirCard};
    uirAct(key, what);
    uirRepaint(key, false);
  }, true);
  const onField = (e) => {
    const f = e.target && e.target.closest ? e.target.closest('[data-uir-field]') : null;
    const box = f && f.closest('[data-uir]');
    if (!box) return;
    const had = !!(UIR.get(box.dataset.uir) || {}).err;
    uirInput(box.dataset.uir, f.dataset.uirField, f.type === 'checkbox' ? String(!!f.checked) : f.value);
    if (had) uirRepaint(box.dataset.uir, true);
  };
  document.addEventListener('input', onField, true);
  document.addEventListener('change', onField, true);
  document.addEventListener('keydown', (e) => {
    const f = e.target && e.target.closest ? e.target.closest('[data-uir-field]') : null;
    const box = f && f.closest('[data-uir]');
    if (!box) return;
    // Escape and Enter are this field's, not the window's (Escape would stop the turn); other keys go on as in any field.
    if (e.key === 'Escape') { f.blur(); e.stopPropagation(); return; }
    if (e.key === 'Enter') e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey && f.tagName === 'INPUT' && f.type !== 'checkbox' && !e.isComposing) {
      e.preventDefault();
      uirAct(box.dataset.uir, {submit: true});
      uirRepaint(box.dataset.uir, true);
    }
  }, true);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {uirAct, uirInput, uirDeliver};
}
