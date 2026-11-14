/* ---------------- Settings › Connections › Phone push (ATO-1129) ----------------
   Loaded BEFORE renderer.js, so it only declares: everything it touches
   (BR, render, esc, ic) is read when a function runs, never at load time.

   The terminal's `atag push`: ntfy phone notifications with no bot to set
   up. Off (the default) the pane is one sentence and Set up; opening the
   tab only reads `notifications.push`, it never turns push on, mints a
   topic or sends anything. Set up runs `atag push on` through
   main/push-ipc.ts, so the agent mints the random topic and writes the
   setting itself, the same as in a terminal; then three steps (install
   ntfy, add the address, send a test), the switch, the privacy note and
   New address. No QR code: the desktop ships no QR library, so step 2
   shows the address with Copy. No quiet hours: a ping goes out when it
   happens.

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
  confirmNew: false,   // New address takes a second click: the phone has to subscribe again
};

/* The ntfy app's store pages, opened in the browser by the [data-url] click handler. */
const PUSH_APP_IOS = 'https://apps.apple.com/app/ntfy/id1625396347';
const PUSH_APP_ANDROID = 'https://play.google.com/store/apps/details?id=io.heckel.ntfy';
const PUSH_TEST_SENT = 'Sent. Did it arrive on your phone?';

/* ---- pure helpers (exported for test/phone-push.test.mjs) ---- */

/* The ops the pane may send, from a `push:<verb>` act. */
function pushParseAct(what) {
  const verb = String(what || '').split(':')[0];
  return ['setup', 'enable', 'test', 'copy', 'newTopic', 'refresh'].includes(verb) ? verb : null;
}

/* Set up only once push is on and has an address; until then the pane is one line and a button. */
function pushIsSetUp(st) {
  return !!(st && st.enabled === true && st.subscribeUrl);
}

/* Step 2's words: tap +, paste the topic name, and what to do with
   "Use another server" (off for ntfy.sh, on with the server's address otherwise). */
function pushSubscribeHint(st, h) {
  const own = st.server && !/^https:\/\/ntfy\.sh\/?$/.test(st.server);
  return 'In ntfy, tap +, paste this topic name and tap Subscribe. '
    + (own ? 'Turn on Use another server and enter <b class="sd-mono">' + h.esc(st.server) + '</b>.'
      : 'Leave Use another server off.');
}

/* Who can read the notifications, in plain words. A server other than ntfy.sh is named. */
function pushPrivacyText(st) {
  if (!st) return '';
  const base = 'Anyone who knows this address can read your notifications, so keep it private. Notifications show a short title and the start of the answer, never tool output.';
  if (/^https:\/\/ntfy\.sh$/.test(st.server)) return base;
  let host = st.server;
  try { host = new URL(st.server).host; } catch (e) { /* keep the raw value */ }
  return 'Notifications go to ' + host + '. ' + base;
}

function phonePushPaneHTML(p, h) {
  const st = p.state;
  const row = (title, d, tail, attr) => '<div class="tk-setrow"' + (attr || '') + '><div class="body"><div class="t">' + title + '</div><div class="d">' + d + '</div></div>' + (tail || '') + '</div>';
  const busy = !!p.busy || p.loading;
  const dis = busy ? ' disabled' : '';
  let body;
  if (p.unsupported) {
    body = '<div class="tk-empty set-empty"><span class="tk-ico tk-ico--lg" aria-hidden="true">' + h.ic('bell') + '</span><h4>Phone push needs a newer agent</h4><p>' + h.esc(p.err || '') + '</p></div>';
  } else if (!st) {
    body = p.err ? '' : '<div class="tk-empty set-empty"><span class="tk-spin"></span><p>Loading…</p></div>';
  } else if (!pushIsSetUp(st)) {
    // Off: one sentence and Set up. Nothing is turned on, minted or sent until that click.
    body = '<div class="tk-card sd-rows" data-push-off>'
      + row('Phone push', 'Get a notification on your phone when a long task finishes or the agent needs you.',
        '<button class="btn btn-p sm" data-act="push:setup"' + dis + '>' + (p.busy === 'on' ? 'Setting up…' : 'Set up') + '</button>')
      + '</div>';
  } else {
    const ext = (label, url) => '<button class="btn btn-s sm" data-url="' + h.esc(url) + '">' + label + '</button>';
    body = '<div class="tk-card sd-rows" data-push-steps>'
      + row('1. Install the free ntfy app', 'On your phone, from the App Store or Google Play.',
        ext('App Store', PUSH_APP_IOS) + ext('Google Play', PUSH_APP_ANDROID), ' data-push-step="1"')
      /* W2 QA: the full address pasted into ntfy's "Use another server"
         field answers 404. The app wants the topic name only, and the
         server switch off for ntfy.sh; Copy copies the name. */
      + row('2. Subscribe to this topic in the app', pushSubscribeHint(st, h)
        + '<div class="sd-mono sd-push-url" data-push-url>' + h.esc(st.topic || '') + '</div>',
        '<button class="btn btn-s sm" data-act="push:copy">Copy</button>', ' data-push-step="2"')
      + row('3. Send a test notification', p.msg === PUSH_TEST_SENT ? h.esc(PUSH_TEST_SENT) : 'Sends one notification to this address now.',
        '<button class="btn btn-s sm" data-act="push:test"' + dis + '>' + (p.busy === 'test' ? 'Sending…' : 'Send a test notification') + '</button>', ' data-push-step="3"')
      + '</div>'
      + '<div class="tk-card sd-rows">'
      + row('Phone push', 'On: a long task that finishes or fails, or the agent waiting for you, sends a notification.',
        '<button class="tk-switch" role="switch" aria-checked="true" aria-label="Phone push" data-act="push:enable"' + dis + '></button>')
      + row('Keep this address private', h.esc(pushPrivacyText(st)))
      + row('New address', 'Stops notifications to the old address. Add the new one in the ntfy app after this.',
        '<button class="btn btn-danger sm" data-act="push:newTopic"' + dis + '>' + (p.confirmNew ? 'Click again to replace' : 'New address') + '</button>')
      + '</div>';
  }
  // The test's answer sits in step 3 itself; every other line is a notice over the rows.
  const msg = p.msg && p.msg !== PUSH_TEST_SENT ? '<div class="tuimsg tk-notice tk-notice--blue">' + h.ic('info') + '<span class="grow">' + h.esc(p.msg) + '</span></div>' : '';
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
      // Never claim the phone got it: ntfy took the message, that is all the app knows.
      PUSH.msg = op === 'test' ? PUSH_TEST_SENT
        : op === 'off' ? 'Phone push is off. The address is kept for next time.'
          : op === 'newTopic' ? 'New address made. Add it in the ntfy app again.'
            : 'Phone push is on. Follow the three steps below.';
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
  const st = PUSH.state;
  // Only these two clicks turn push on: Set up while it is off, and the switch.
  if (verb === 'setup') { if (st && !pushIsSetUp(st)) phonePushRun('on'); return; }
  if (verb === 'enable') { if (st) phonePushRun(pushIsSetUp(st) ? 'off' : 'on'); return; }
  if (verb === 'test') { if (pushIsSetUp(st)) phonePushRun('test'); return; }
  if (verb === 'copy') { if (pushIsSetUp(st) && typeof copyText === 'function') copyText(st.topic, 'Topic copied', 'Paste it in the ntfy app'); return; }
  if (verb === 'newTopic') { if (!pushIsSetUp(st)) return; if (armed) phonePushRun('newTopic'); else { PUSH.confirmNew = true; render(); } return; }
  if (verb === 'refresh') phonePushRefresh();
}

if (typeof module !== 'undefined') module.exports = {PUSH, PUSH_TEST_SENT, PUSH_APP_IOS, PUSH_APP_ANDROID, pushParseAct, pushIsSetUp, pushPrivacyText, phonePushPaneHTML, phonePushAct};
