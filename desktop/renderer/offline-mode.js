/* ATO-1087: Settings › Privacy › Offline mode. The switch and the counter
   belong to the agent's network kill switch (ATO-1084, GET/POST
   /api/offline-mode): this file only shows what the agent reports. An agent
   without the route gets a disabled switch and "Update the agent to use
   offline mode."; the "sent out" line is the agent's own number, never a
   stand-in zero.
   Loaded before renderer.js; declares only. Shared by the renderer and the
   Node checks (test/offline-mode.test.mjs). No DOM, no IPC of its own. */

const OFFLINE_OLD_AGENT = 'Update the agent to use offline mode.';
const OFFLINE_NO_COUNTER = 'Couldn’t read the outbound counter from the agent.';

function offlineCount(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
}

/** The agent's counter, or null when any field is missing or bad (nothing is guessed). */
function offlineEgress(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const bytesOut = offlineCount(raw.bytesOut);
  const requestsOut = offlineCount(raw.requestsOut);
  const requestsBlocked = offlineCount(raw.requestsBlocked);
  const since = typeof raw.since === 'string' && Number.isFinite(Date.parse(raw.since)) ? raw.since : null;
  if (bytesOut === null || requestsOut === null || requestsBlocked === null || since === null) return null;
  return {bytesOut, requestsOut, requestsBlocked, since};
}

/** "0 bytes", "1 byte", "1.5 KB", "12 MB". */
function offlineBytes(n) {
  if (n === 1) return '1 byte';
  if (n < 1024) return n + ' bytes';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const shown = v < 10 ? v.toFixed(1).replace(/\.0$/, '') : String(Math.round(v));
  return shown + ' ' + units[i];
}

/** "0 bytes sent out since 14:05 · 3 requests blocked", or null without a counter. */
function offlineEgressLine(egress) {
  if (!egress) return null;
  const d = new Date(egress.since);
  const clock = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  let line = offlineBytes(egress.bytesOut) + ' sent out since ' + clock;
  if (egress.requestsBlocked > 0) line += ' · ' + egress.requestsBlocked + (egress.requestsBlocked === 1 ? ' request' : ' requests') + ' blocked';
  return line;
}

/* `api.read()`       → {supported:false} | {supported:true, ok:true, data:{enabled, egress}} | {supported:true, ok:false, error}
   `api.set(enabled)` → the same, after the agent switched. */
function createOfflineMode(api) {
  const st = {supported: null, loading: false, busy: false, error: null, enabled: null, egress: null, serial: 0};
  const take = (res) => {
    if (!res || res.supported === false) { st.supported = false; st.enabled = null; st.egress = null; st.error = null; return false; }
    st.supported = true;
    if (!res.ok || !res.data || typeof res.data.enabled !== 'boolean') { st.error = (res && res.error) || 'could not read offline mode'; return false; }
    st.error = null;
    st.enabled = res.data.enabled;
    st.egress = offlineEgress(res.data.egress);
    return true;
  };
  return {
    state: st,
    /* Read again. A late answer for an older read, or one that lands during a switch, is dropped. */
    async load() {
      const mine = ++st.serial;
      st.loading = true;
      const res = await Promise.resolve().then(() => api.read()).catch((error) => ({supported: true, ok: false, error: String(error)}));
      if (mine !== st.serial) return st;
      st.loading = false;
      take(res);
      return st;
    },
    /* Another agent is on the wire: it may have the route the last one lacked. */
    reset() {
      st.supported = null; st.serial++; st.loading = false; st.busy = false; st.error = null; st.enabled = null; st.egress = null;
    },
    /* Flip the switch through the agent. Only when the agent said it has one and what it is now. */
    async toggle() {
      if (st.busy || st.supported !== true || typeof st.enabled !== 'boolean') return {ok: false};
      const next = !st.enabled;
      st.busy = true;
      st.serial++; // a read in flight answers for the old state
      const res = await Promise.resolve().then(() => api.set(next)).catch((error) => ({supported: true, ok: false, error: String(error)}));
      st.busy = false;
      st.loading = false;
      if (take(res)) return {ok: true, enabled: st.enabled};
      if (st.supported === false) return {ok: false, unsupported: true};
      st.error = 'Couldn’t switch offline mode: ' + ((res && res.error) || 'unknown error');
      return {ok: false};
    },
  };
}

/** The Offline mode row at the top of Privacy. deps: {esc}. */
function offlineModeHTML(st, deps) {
  const {esc} = deps;
  const known = st.supported === true && typeof st.enabled === 'boolean';
  const on = known && st.enabled;
  const old = st.supported === false;
  let help = '';
  if (old) help = '<div class="tk-help set-offline-old">' + esc(OFFLINE_OLD_AGENT) + '</div>';
  else if (known) {
    const line = offlineEgressLine(st.egress);
    help = '<div class="tk-help set-offline-count">' + esc(line || OFFLINE_NO_COUNTER) + '</div>';
  }
  if (st.error && !old) help += '<div class="tk-help tk-help--warn set-offline-err">' + esc(st.error)
    + ' <button class="set-link" data-act="offline:reload">Try again</button></div>';
  const pending = !old && !known && !st.error;
  return '<div class="tk-setrow set-offline">'
    + '<div class="body"><div class="t">Offline mode</div>'
      + '<div class="d">When on, the agent blocks network requests to anything but this computer. The count is what it sent to other hosts.</div>'
      + help
    + '</div>'
    + (pending || st.busy ? '<span class="set-state" aria-hidden="true"><span class="tk-spin"></span></span>' : '')
    + '<button class="tk-switch' + (on ? ' on' : '') + '" role="switch" aria-checked="' + on + '" aria-label="Offline mode" data-act="offline:toggle"'
      + (!known || st.busy ? ' disabled' : '')
      + ' title="' + esc(old ? OFFLINE_OLD_AGENT : 'Turn offline mode ' + (on ? 'off' : 'on')) + '"></button>'
    + '</div>';
}

if (typeof module !== 'undefined') module.exports = {OFFLINE_OLD_AGENT, OFFLINE_NO_COUNTER, offlineEgress, offlineBytes, offlineEgressLine, createOfflineMode, offlineModeHTML};
