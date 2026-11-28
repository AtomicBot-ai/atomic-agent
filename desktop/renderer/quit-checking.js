/* ---------------- ATO-2754: "Checking running chats…" while a quit waits ----------------
   Loaded after renderer.js (its toast, S.toasts and renderToasts). The first
   Quit asks the agent what is still running before it asks the person
   (main/quit-question.ts); when that answer is slow, main says {on: true}
   (main/quit-checking.ts) and this shows a toast, then {on: false} when the
   answer is in and the question, or the quit, comes. The toast goes then,
   so a Cancel in the question leaves nothing stale behind. */

const QC = {id: 0};

/** The toast for main's `{on}`: shown once, taken away when the check is over. */
function quitCheckingApply(payload, deps) {
  const on = !!(payload && payload.on === true);
  if (on) {
    if (QC.id) return;
    deps.toast('Checking running chats…', 'Asking the agent what is still running.');
    QC.id = deps.lastToastId();
    return;
  }
  if (!QC.id) return;
  const id = QC.id;
  QC.id = 0;
  deps.drop(id);
}

if (typeof window !== 'undefined' && window.atomic && typeof window.atomic.onQuitChecking === 'function') {
  window.atomic.onQuitChecking((p) => quitCheckingApply(p, {
    toast: (t, s) => toast(t, s),
    lastToastId: () => S.toastId,
    drop: (id) => { S.toasts = S.toasts.filter((x) => x.id !== id); renderToasts(); },
  }));
}

if (typeof module !== 'undefined') module.exports = {QC, quitCheckingApply};
