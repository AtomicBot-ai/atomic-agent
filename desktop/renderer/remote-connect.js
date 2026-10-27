/* ATO-1127: the "Connect to another computer" window (main.ts openRemoteConnect). */
(async () => {
  const BR = window.atomic;
  const $ = (id) => document.getElementById(id);
  // ATO-1240: the body scrolls; a line said is brought into view above the pinned buttons.
  const say = (text, tone) => { const m = $('msg'); m.textContent = text || ''; m.className = 'msg' + (tone ? ' ' + tone : ''); if (text && m.scrollIntoView) m.scrollIntoView({block: 'nearest'}); };
  const now = BR && BR.remoteGet ? await BR.remoteGet() : null;
  if (now && now.url) { $('url').value = now.url; say('Connected to ' + now.url + (now.connected ? '' : ' (not answering)'), now.connected ? 'ok' : 'bad'); }
  else say('This app runs its own agent on this computer.');
  // An http:// address that is not this computer: say the key travels in clear.
  const httpNote = () => { const v = $('url').value.trim(); $('http-note').hidden = !(/^http:\/\//i.test(v) && !/^http:\/\/(localhost|127\.|\[::1\])/i.test(v)); };
  $('url').addEventListener('input', httpNote); httpNote();
  const busy = (on) => { for (const id of ['connect', 'local', 'cancel']) $(id).disabled = on; };
  $('connect').addEventListener('click', async () => {
    busy(true); say('Checking…');
    const r = await BR.remoteSet({ url: $('url').value, token: $('token').value });
    busy(false);
    if (r && r.ok) { say('Connected.', 'ok'); setTimeout(() => window.close(), 600); }
    else say((r && r.error) || 'Could not connect.', 'bad');
  });
  $('local').addEventListener('click', async () => {
    busy(true); say('Starting the agent on this computer…');
    await BR.remoteClear();
    window.close();
  });
  $('cancel').addEventListener('click', () => window.close());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.close(); });
})();
