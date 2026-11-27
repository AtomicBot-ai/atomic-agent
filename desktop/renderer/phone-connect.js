/* ---------------- Settings › Connections › Connect phone (ATO-2493) ----------------
   Loaded BEFORE renderer.js, so it only declares: everything it touches
   (BR, render, esc, ic, qrSvg, copyText) is read when a function runs.

   The desktop side of `atag pair` (ATO-2308): a phone opens the agent's web
   panel without typing the API key. Off by default, the agent answers this
   computer only (127.0.0.1). The switch "Allow phones on this Wi-Fi",
   like LM Studio's "Serve on Local Network", restarts it on 0.0.0.0
   (main/phone-access.ts); every phone still needs a code from this card.
   Then: a QR code of a one-time link and the same pairing as a short code
   (for the iPhone home-screen app, which keeps its own sign-in, ATO-2494),
   and the paired phones with when each was last seen and Sign out.
   A tunnel (reach the phone away from home) is a later step. */

const PHONE = {
  status: null,       // main/phone-ipc.ts PhoneStatus once read
  loading: false,
  err: null,          // {error, detail?} of the last read or write
  busy: null,         // 'switch' | 'pair' | 'devices' | 'revoke:<id>'
  pairing: null,      // {url, code, expiresAt, others} after Pair a phone
  devices: null,      // [{id, name, createdAt, lastSeenAt}] once read
  devicesErr: null,   // {error, detail?}
  confirmRevoke: null, // the id whose Sign out was clicked once
};

/* ---- pure helpers (exported for test/phone-connect.test.mjs) ---- */

/* The verbs the pane may send, from a `phone:<verb>[:<arg>]` act. */
function phoneParseAct(what) {
  const s = String(what || '');
  const i = s.indexOf(':');
  const verb = i < 0 ? s : s.slice(0, i);
  const arg = i < 0 ? '' : s.slice(i + 1);
  if (['enable', 'pair', 'copy', 'refresh'].includes(verb)) return {verb, arg: ''};
  if (verb === 'revoke' && /^[0-9a-f]{8}$/.test(arg)) return {verb, arg};
  return null;
}

/* "14:05", when a pairing stops working, in the viewer's own clock. */
function phoneExpiryText(expiresAt) {
  const t = Date.parse(expiresAt);
  if (!Number.isFinite(t)) return '';
  try { return new Date(t).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}); } catch (e) { return ''; }
}

/* "just now", "3 hours ago", "5 days ago". */
function phoneSeenText(at, now) {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return 'never';
  const s = Math.max(0, (now == null ? Date.now() : now) - t) / 1000;
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return m + (m === 1 ? ' minute ago' : ' minutes ago');
  const h = Math.floor(m / 60); if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
  const d = Math.floor(h / 24); return d === 1 ? 'yesterday' : d + ' days ago';
}

/* A notice with the agent's own words folded behind Details. */
function phoneErrorHTML(e, h) {
  if (!e || !e.error) return '';
  const more = e.detail ? '<details class="tk-help"><summary>Details</summary><span class="sd-mono">' + h.esc(e.detail) + '</span></details>' : '';
  return '<div class="tuierr tk-notice tk-notice--red" data-phone-error>' + h.ic('alert') + '<span class="grow">' + h.esc(e.error) + more + '</span></div>';
}

function phoneRow(title, d, tail, attr) {
  return '<div class="tk-setrow"' + (attr || '') + '><div class="body"><div class="t">' + title + '</div><div class="d">' + d + '</div></div>' + (tail || '') + '</div>';
}

function phonePairingHTML(p, h) {
  const dis = p.busy ? ' disabled' : '';
  if (!p.pairing) {
    return '<div class="tk-card sd-rows" data-phone-pair>'
      + phoneRow('Pair a phone', 'Shows a QR code for the phone\'s camera. It works once, for 5 minutes.',
        '<button class="btn btn-p sm" data-act="phone:pair"' + dis + '>' + (p.busy === 'pair' ? 'Making a code…' : 'Pair a phone') + '</button>')
      + '</div>';
  }
  const pr = p.pairing;
  const qr = h.qr || (typeof qrSvg === 'function' ? qrSvg : null);
  const svg = qr ? qr(pr.url, 'QR code: open the Atomic Agent panel on your phone') : '';
  const until = phoneExpiryText(pr.expiresAt);
  const code = pr.code
    ? '<p class="sd-cap">In an app added to the iPhone home screen, tap Connect this app and type:</p>'
      + '<div class="sd-paircode" data-phone-code aria-label="Pairing code">' + h.esc(pr.code) + '</div>'
    : '';
  const others = pr.others && pr.others.length
    ? '<p class="sd-cap" data-phone-others>If the phone cannot open it, this computer also answers at ' + pr.others.map(h.esc).join(', ') + '.</p>'
    : '';
  return '<div class="tk-card sd-rows" data-phone-pair>'
    + '<div class="sd-qr" data-phone-qr>' + svg + '<p class="sd-cap">On your phone, on the same Wi-Fi: scan this with the camera, open the link, and tap Connect this phone.</p></div>'
    + code + others
    + '<div class="sd-acts"><span class="sd-cap">Works once' + (until ? ', until <b>' + h.esc(until) + '</b>' : '') + '.</span><span class="sd-grow"></span>'
    + '<button class="btn btn-s sm" data-act="phone:copy">Copy link</button>'
    + '<button class="btn btn-s sm" data-act="phone:pair"' + dis + '>New code</button></div>'
    + '</div>';
}

function phoneDevicesHTML(p, h) {
  let inner;
  if (p.devicesErr) inner = phoneErrorHTML(p.devicesErr, h);
  else if (!p.devices) inner = '<div class="tk-empty set-empty"><span class="tk-spin"></span><p>Loading…</p></div>';
  else if (!p.devices.length) inner = '<div class="tk-empty set-empty" data-phone-empty><p>No phones paired yet.</p></div>';
  else {
    inner = p.devices.map((d) => {
      const armed = p.confirmRevoke === d.id;
      const busy = p.busy === 'revoke:' + d.id;
      return phoneRow(h.esc(d.name) + ' <span class="sd-cap sd-mono">' + h.esc(d.id) + '</span>',
        'Last seen ' + h.esc(phoneSeenText(d.lastSeenAt, p.now)) + '. Signed out on its own after 30 days without use.',
        '<button class="btn btn-danger sm" data-act="phone:revoke:' + h.esc(d.id) + '"' + (p.busy ? ' disabled' : '') + '>'
          + (busy ? 'Signing out…' : armed ? 'Click again to sign out' : 'Sign out') + '</button>', ' data-phone-device="' + h.esc(d.id) + '"');
    }).join('');
  }
  return '<div class="tk-card sd-rows" data-phone-devices><div class="tk-setrow"><div class="body"><div class="t">Paired phones</div></div></div>' + inner + '</div>';
}

function phoneConnectPaneHTML(p, h) {
  const st = p.status;
  if (!st) {
    const body = p.err ? '' : '<div class="tk-empty set-empty"><span class="tk-spin"></span><p>Loading…</p></div>';
    return '<div class="sd-pane sd-phone">' + phoneErrorHTML(p.err, h) + body + '</div>';
  }
  if (st.remote) {
    return '<div class="sd-pane sd-phone"><div class="tk-empty set-empty" data-phone-remote><span class="tk-ico tk-ico--lg" aria-hidden="true">' + h.ic('plug')
      + '</span><h4>Pair on the other computer</h4><p>This app uses the agent on another computer. Run atag pair there to connect a phone.</p></div></div>';
  }
  const on = st.enabled;
  const sw = '<button class="tk-switch" role="switch" aria-checked="' + on + '" aria-label="Allow phones on this Wi-Fi" data-act="phone:enable"' + (p.busy ? ' disabled' : '') + '></button>';
  const lead = '<div class="tk-card sd-rows" data-phone-switch>'
    + phoneRow('Allow phones on this Wi-Fi', p.busy === 'switch' ? 'Restarting the agent…'
      : on ? 'On: devices on your network can reach the agent, and each one still needs a code from here first. The connection on your Wi-Fi is not encrypted, so use it at home or at work, not on public Wi-Fi.'
        : 'Off: only this computer can reach the agent. Turn it on to open the agent\'s panel on a phone without typing a key. Turning it on or off restarts the agent.', sw)
    + '</div>';
  let middle = '';
  if (on && st.listening) {
    middle = phonePairingHTML(p, h)
      + '<p class="sd-cap" data-phone-firewall>Your computer may ask whether Atomic Agent can accept incoming connections. Choose Allow (on Windows, Private networks).</p>';
  } else if (on && !p.busy) {
    middle = '<div class="tuimsg tk-notice tk-notice--blue" data-phone-waiting>' + h.ic('info') + '<span class="grow">Waiting for the agent to start on your network…</span><button class="btn btn-s sm" data-act="phone:refresh">Check again</button></div>';
  }
  return '<div class="sd-pane sd-phone">' + phoneErrorHTML(p.err, h) + lead + middle + phoneDevicesHTML(p, h) + '</div>';
}

/* ---- runtime (needs the bridge and renderer.js globals) ---- */

function phoneTab() { return phoneConnectPaneHTML(Object.assign({}, PHONE, {now: Date.now()}), {esc, ic}); }

function phoneFailure(res) {
  return {error: (res && res.error) || 'The agent did not answer.', ...(res && res.detail ? {detail: res.detail} : {})};
}

function phoneTabEntered() { PHONE.confirmRevoke = null; phoneRefresh(); }

function phoneRefresh() {
  if (typeof BR === 'undefined' || !BR || !BR.phoneStatus) { PHONE.err = {error: 'Connecting a phone needs the desktop bridge.'}; return Promise.resolve(); }
  PHONE.loading = true; render();
  return Promise.all([BR.phoneStatus(), BR.phoneDevices()]).then(([st, dev]) => {
    PHONE.loading = false;
    if (st && st.ok) { PHONE.status = st; PHONE.err = null; } else PHONE.err = phoneFailure(st);
    if (!st || !st.listening) PHONE.pairing = null;
    if (dev && dev.ok) { PHONE.devices = dev.devices; PHONE.devicesErr = null; } else { PHONE.devices = null; PHONE.devicesErr = phoneFailure(dev); }
    render();
  }, (e) => { PHONE.loading = false; PHONE.err = {error: 'The agent did not answer.', detail: String((e && e.message) || e)}; render(); });
}

function phoneRun(busy, job, after) {
  if (!BR || PHONE.busy) return Promise.resolve();
  PHONE.busy = busy; PHONE.err = null; render();
  return job().then((res) => {
    PHONE.busy = null;
    if (res && res.ok) after(res); else PHONE.err = phoneFailure(res);
    render();
  }, (e) => { PHONE.busy = null; PHONE.err = {error: 'The agent did not answer.', detail: String((e && e.message) || e)}; render(); });
}

function phoneConnectAct(what) {
  const a = phoneParseAct(what);
  if (!a) return;
  const armed = PHONE.confirmRevoke;
  PHONE.confirmRevoke = null;
  const st = PHONE.status;
  if (a.verb === 'refresh') return phoneRefresh();
  if (a.verb === 'enable') {
    if (!st || st.remote) return;
    return phoneRun('switch', () => BR.phoneSetEnabled(!st.enabled), (res) => { PHONE.status = res; PHONE.pairing = null; phoneRefresh(); });
  }
  if (a.verb === 'pair') return st && st.listening ? phoneRun('pair', () => BR.phonePair(), (res) => { PHONE.pairing = res; }) : undefined;
  if (a.verb === 'copy') { if (PHONE.pairing && typeof copyText === 'function') copyText(PHONE.pairing.url, 'Link copied', 'Open it on your phone'); return; }
  if (a.verb === 'revoke') {
    if (armed !== a.arg) { PHONE.confirmRevoke = a.arg; render(); return; }
    return phoneRun('revoke:' + a.arg, () => BR.phoneRevoke(a.arg), () => phoneRefresh());
  }
}

if (typeof module !== 'undefined') module.exports = {PHONE, phoneParseAct, phoneExpiryText, phoneSeenText, phoneConnectPaneHTML, phoneConnectAct};
