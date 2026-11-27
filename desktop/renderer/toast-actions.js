/* ---------------- ATO-2478: a button on a toast ----------------
   Loaded before renderer.js; declares only, and reads renderer.js globals
   (S, toast, renderToasts, esc) at call time. The Node checks load it as is
   (test/toast-actions.test.mjs).

   A toast was text and a dismiss cross. toastWithAction(t, s, kind, action)
   raises the same toast with one button under its text ({label, run}), for
   example "Open" on "Background chat finished". renderer.js toastHTML draws
   it through one hook (toastActionHTML). The button carries no data-act, so
   the window's own click handler never sees it: the capture listener below
   runs it, and the toast goes the moment it is pressed. The action lives as
   long as its toast (toast() expires every toast after 6 s).

   The precedent: Slack's and Linear's "View" on a toast, and macOS
   notifications that open the thing they are about when clicked. */

const TOASTACT = {byId: new Map()};
const TOASTACT_LIFE_MS = 7000;   // a little past toast()'s 6 s, then the entry is dropped

/** A toast with one button. Without a usable action it is a plain toast. */
function toastWithAction(t, s, kind, action) {
  const ok = action && typeof action.run === 'function' && typeof action.label === 'string' && action.label.trim();
  if (!ok || typeof S === 'undefined') { toast(t, s, kind); return null; }
  // toast() takes the next id (++S.toastId) and draws it at once, so the action is known before it is drawn.
  const id = S.toastId + 1;
  TOASTACT.byId.set(id, {label: action.label.trim().slice(0, 24), run: action.run});
  toast(t, s, kind);
  if (S.toastId !== id) { TOASTACT.byId.delete(id); return null; }
  setTimeout(() => TOASTACT.byId.delete(id), TOASTACT_LIFE_MS);
  return id;
}

/** renderer.js toastHTML: the button under the toast's text, or nothing. */
function toastActionHTML(t) {
  const a = t && TOASTACT.byId.get(t.id);
  if (!a) return '';
  const e = typeof esc === 'function' ? esc : (x) => String(x);
  return '<span class="toast-acts"><button class="btn btn-s sm toast-act" type="button" data-toastact="' + t.id + '">'
    + e(a.label) + '</button></span>';
}

/** The button pressed: the toast goes, then its action runs. False for a toast that has no action (any more). */
function toastActionRun(id) {
  const a = TOASTACT.byId.get(id);
  if (!a) return false;
  TOASTACT.byId.delete(id);
  if (typeof S !== 'undefined' && Array.isArray(S.toasts)) {
    S.toasts = S.toasts.filter((x) => x.id !== id);
    if (typeof renderToasts === 'function') renderToasts();
  }
  try { a.run(); } catch (e) { /* the action's own failure is its own to report */ }
  return true;
}

if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') {
  document.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('[data-toastact]') : null;
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    toastActionRun(Number(b.getAttribute('data-toastact')));
  }, true);
}

if (typeof module !== 'undefined') module.exports = {TOASTACT, TOASTACT_LIFE_MS, toastWithAction, toastActionHTML, toastActionRun};
