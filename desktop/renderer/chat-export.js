/* ---------------- ATO-1054: exporting a chat ----------------
   Loaded before renderer.js; declares only.

   The chat row's "…" menu has Export… for a chat the agent has stored.
   Main asks where in the system save dialog (Markdown, PDF, Word or a web
   page, picked by the file type) and writes the file the agent rendered
   (main/chat-export.ts). This side only starts it and says how it went. */

/* The toast for a result from window.atomic.exportSession:
   null when nothing needs saying (the person closed the dialog). */
function chatExportToast(res) {
  if (!res) return {t: 'Could not export the chat', s: 'No answer from the app', kind: 'bad'};
  if (res.ok) return {t: 'Chat exported', s: String(res.path || '')};
  if (res.reason === 'canceled') return null;
  return {t: 'Could not export the chat', s: String(res.error || res.reason || ''), kind: 'bad'};
}

/* ---- renderer side (globals from renderer.js, read at call time) ---- */

function chatExport(id) {
  if (!id) return;
  if (!BR || !BR.exportSession) { toast('Could not export the chat', 'Not connected to the agent', 'bad'); return; }
  BR.exportSession(id).then((res) => {
    const m = chatExportToast(res);
    if (m) toast(m.t, m.s, m.kind);
  }, (e) => toast('Could not export the chat', String(e), 'bad'));
}

if (typeof module !== 'undefined') module.exports = {chatExportToast};
