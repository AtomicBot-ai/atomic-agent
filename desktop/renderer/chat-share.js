/* ---------------- ATO-581: sharing a chat ----------------
   Loaded before renderer.js; declares only.

   The chat row's "…" menu has Share chat… for a chat the agent has stored.
   Main (main/chat-share.ts) asks where to save, has the agent write one
   redacted file (`atag share`), says what was removed, and offers a secret
   GitHub gist only after a second, explicit confirm. This side only starts
   it and says how it went. */

/* The toast for a result from window.atomic.shareSession:
   null when nothing needs saying (the person closed the save dialog). */
function chatShareToast(res) {
  if (!res) return {t: 'Could not share the chat', s: 'No answer from the app', kind: 'bad'};
  if (res.ok && res.gistUrl) return {t: 'Secret gist link copied', s: String(res.gistUrl)};
  if (res.ok && res.gistError) return {t: 'Saved, but not uploaded', s: String(res.gistError), kind: 'bad'};
  if (res.ok) return {t: 'Redacted chat saved', s: String(res.path || '')};
  if (res.reason === 'canceled') return null;
  return {t: 'Could not share the chat', s: String(res.error || res.reason || ''), kind: 'bad'};
}

/* ---- renderer side (globals from renderer.js, read at call time) ---- */

function chatShare(id) {
  if (!id) return;
  if (!BR || !BR.shareSession) { toast('Could not share the chat', 'Update Atomic Agent to share chats', 'bad'); return; }
  BR.shareSession(id).then((res) => {
    const m = chatShareToast(res);
    if (m) toast(m.t, m.s, m.kind);
  }, (e) => toast('Could not share the chat', String(e), 'bad'));
}

if (typeof module !== 'undefined') module.exports = {chatShareToast};
