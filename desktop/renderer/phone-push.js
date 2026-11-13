/* ---------------- Settings › Connections › Phone push (ATO-1129) ----------------
   Loaded BEFORE renderer.js, so it only declares: everything it touches
   (BR, render, esc, ic) is read when a function runs, never at load time.

   The terminal's `atag push`: ntfy phone notifications with no bot to set
   up. The switch runs `atag push on|off` through main/push-ipc.ts, so the
   agent mints the random topic and writes notifications.push itself, the
   same as in a terminal; the pane shows the URL to subscribe to in the
   ntfy app, a Send test button, and the warning that a topic on ntfy.sh
   is public by name. No quiet hours: a ping goes out when it happens.

   What pings: a chat turn that ran long or failed while the window was in
   the background (main/turn-notify.ts), and tasks or downloads set to
   notify by push. The agent reads the setting from disk each time, so no
   restart is needed. */

const PUSH = {
  state: null,         // {enabled, server, topic, subscribeUrl} once read
  err: null,           // the last read's or write's error
  unsupported: false,  // the agent has no `push` command yet
  loading: false,
  busy: null,          // the running op: 'on' | 'off' | 'test' | 'newTopic'
  msg: null,           // a line after a write or a test
  confirmNew: false,   // New topic takes a second click: the phone has to subscribe again
};

/* ---- pure helpers (exported for test/phone-push.test.mjs) ---- */

/* The ops the pane may send, from a `push:<verb>` act. */
function pushParseAct(what) {
  const verb = String(what || '').split(':')[0];
  return ['enable', 'test', 'newTopic', 'refresh'].includes(verb) ? verb : null;
}

/* The one-line status the pane leads with. */
function pushStatusLine(st) {
  if (!st) return {chip:'', line:''};
  if (!st.enabled) return {chip:'Off', line:'Turn it on to get a ping on your phone when a long reply finishes or fails while the app is in the background.'};
  if (!st.subscribeUrl) return {chip:'Off', line:'Push is on but has no topic yet. Turn it off and on again.'};
  return {chip:'On', line:'Subscribe to this topic in the ntfy app (iPhone or Android) to get the pings.'};
}

/* Topics on the public server are readable by anyone who knows the name. */
function pushPrivacyText(st) {
  if (!st) return '';
  let host = st.server;
  try { host = new URL(st.server).host; } catch (e) { /* keep the raw value */ }
  return /^https:\/\/ntfy\.sh$/.test(st.server)
    ? 'Topics on ' + host + ' are public by name: anyone who learns this topic can read your pings. Keep it private. A ping carries a short title and the start of the answer, never tool output.'
    : 'Pings go to ' + host + '. Keep the topic private. A ping carries a short title and the start of the answer, never tool output.';
}

function phonePushPaneHTML(p, h) {
  const st = p.state;
  const row = (title, d, tail) => '<div class="tk-setrow"><div class="body"><div class="t">' + title + '</div><div class="d">' + d + '</div></div>' + tail + '</div>';
  const busy = !!p.busy || p.loading;
  let body;
  if (p.unsupported) {
    body = '<div class="tk-empty set-empty"><span class="tk-ico tk-ico--lg" aria-hidden="true">' + h.ic('bell') + '</span><h4>Phone push needs a newer agent</h4><p>' + h.esc(p.err || '') + '</p></div>';
  } else if (!st) {
    body = p.err ? '' : '<div class="tk-empty set-empty"><span class="tk-spin"></span><p>Loading…</p></div>';
  } else {
    const status = pushStatusLine(st);
    body = '<div class="tk-card pad sd-tgcard sd-pushcard"><h3 class="sd-title">Phone push <span class="tk-chip tk-chip--sm">' + h.esc(status.chip) + '</span></h3>'
      + '<p>' + h.esc(status.line) + '</p></div>'
      + '<div class="tk-card sd-rows">'
      + row('Send pings to my phone', 'Through ntfy, no bot or account needed.',
        '<button class="tk-switch" role="switch" aria-checked="' + (st.enabled === true) + '" aria-label="Send pings to my phone" data-act="push:enable"' + (busy ? ' disabled' : '') + '></button>')
      + (st.enabled && st.subscribeUrl
        ? row('Topic', h.esc(pushPrivacyText(st)),
          '<span class="tk-chip tk-chip--sm sd-mono sd-push-url" data-push-url>' + h.esc(st.subscribeUrl) + '</span>')
          + row('Check it', 'Sends one ping now.',
            '<button class="btn btn-s sm" data-act="push:test"' + (busy ? ' disabled' : '') + '>' + (p.busy === 'test' ? 'Sending…' : 'Send test') + '</button>')
          + row('New topic', 'Stops pings to the old topic. Subscribe the phone again after this.',
            '<button class="btn btn-danger sm" data-act="push:newTopic"' + (busy ? ' disabled' : '') + '>' + (p.confirmNew ? 'Click again to replace' : 'New topic') + '</button>')
        : '')
      + '</div>';
  }
  const msg = p.msg ? '<div class="tuimsg tk-notice tk-notice--blue">' + h.ic('info') + '<span class="grow">' + h.esc(p.msg) + '</span></div>' : '';
  const err = p.err && !p.unsupported ? '<div class="tuierr tk-notice tk-notice--red">' + h.ic('alert') + '<span class="grow">' + h.esc(p.err) + '</span></div>' : '';
  return '<div class="sd-pane sd-push">' + err + msg + body + '</div>';
}

/* ---- runtime (needs the bridge and renderer.js globals) ---- */

function pushTab() { return phonePushPaneHTML(PUSH, {esc, ic}); }

function phonePushTabEntered() { PUSH.msg = null; PUSH.confirmNew = false; phonePushRefresh(); }

function phonePushRefresh() {
  if (typeof BR === 'undefined' || !BR || !BR.pushStatus) { PUSH.err = 'Phone push needs the desktop bridge.'; return Promise.resolve(); }
  PUSH.loading = true; render();
  return BR.pushStatus().then((res) => {
    PUSH.loading = false;
    if (res && res.ok) { PUSH.state = res.push; PUSH.err = null; PUSH.unsupported = false; }
    else { PUSH.unsupported = !!(res && res.unsupported); PUSH.err = (res && res.error) || 'The agent did not answer.'; }
    render();
  }, (e) => { PUSH.loading = false; PUSH.err = String((e && e.message) || e); render(); });
}

function phonePushRun(op) {
  if (!BR || !BR.pushSet || PUSH.busy) return Promise.resolve();
  PUSH.busy = op; PUSH.msg = null; PUSH.err = null; render();
  return BR.pushSet(op).then((res) => {
    PUSH.busy = null;
    if (res && res.ok) {
      if (res.push) PUSH.state = res.push;
      PUSH.msg = op === 'test' ? 'Test ping sent. Check your phone.'
        : op === 'off' ? 'Phone push turned off. The topic is kept for next time.'
          : op === 'newTopic' ? 'New topic made. Subscribe to it in the ntfy app.'
            : 'Phone push turned on. Subscribe to the topic below in the ntfy app.';
    } else {
      PUSH.unsupported = !!(res && res.unsupported);
      PUSH.err = (res && res.error) || 'The agent did not answer.';
    }
    return res && res.ok && !res.push ? phonePushRefresh() : render();
  }, (e) => { PUSH.busy = null; PUSH.err = String((e && e.message) || e); render(); });
}

function phonePushAct(what) {
  const verb = pushParseAct(what);
  const armed = PUSH.confirmNew;
  PUSH.confirmNew = false;
  if (verb === 'enable') { if (PUSH.state) phonePushRun(PUSH.state.enabled ? 'off' : 'on'); return; }
  if (verb === 'test') { phonePushRun('test'); return; }
  if (verb === 'newTopic') { if (armed) phonePushRun('newTopic'); else { PUSH.confirmNew = true; render(); } return; }
  if (verb === 'refresh') phonePushRefresh();
}

if (typeof module !== 'undefined') module.exports = {PUSH, pushParseAct, pushStatusLine, pushPrivacyText, phonePushPaneHTML, phonePushAct};
