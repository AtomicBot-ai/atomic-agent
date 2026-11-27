/* ATO-1082: Settings › Privacy › Privacy Shield. The switch and the "masked N"
   counter belong to the agent (GET/POST /api/privacy-shield, ATO-1081): this
   file only shows what the agent reports. An agent without the route gets a
   disabled switch and "Update the agent to use Privacy Shield."; the counter
   is the agent's own number, never a stand-in zero.
   Loaded before renderer.js; declares only. renderer.js keeps four hook
   lines (create, entry to Privacy, the row, the act). Shared by the renderer
   and the Node checks (test/privacy-shield.test.mjs). No DOM, no IPC. */

const SHIELD_OLD_AGENT = 'Update the agent to use Privacy Shield.';
const SHIELD_NO_COUNTER = "Couldn't read the masked counter from the agent.";
/* ATO-2744: the sentences a failure shows; what the agent or the bridge said goes under Details. */
const SHIELD_READ_FAILED = "Couldn't read Privacy Shield from the agent.";
const SHIELD_SWITCH_FAILED = "Couldn't switch Privacy Shield. Try again.";

function shieldCount(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
}

/** "Masked 3 values before they went to a cloud model, since the agent started.", or null. */
function shieldCounterLine(masked) {
  if (masked === null || masked === undefined) return null;
  return 'Masked ' + masked + (masked === 1 ? ' value' : ' values') + ' before they went to a cloud model, since the agent started.';
}

/* `api.read()`       → {supported:false} | {supported:true, ok:true, data:{enabled, masked}} | {supported:true, ok:false, error}
   `api.set(enabled)` → the same, after the agent switched.
   `st.error` is null or {text, detail} (human-error.js draws it).
   `hooks` (renderer only): {render, toast, shown, gen} — repaint, a toast,
   whether Privacy is on screen, and the agent generation (a new agent resets). */
function createPrivacyShield(api, hooks) {
  const h = hooks || {};
  const st = {supported: null, loading: false, busy: false, error: null, enabled: null, masked: null, serial: 0};
  let gen = null;
  let timer = null;
  const take = (res) => {
    if (!res || res.supported === false) { st.supported = false; st.enabled = null; st.masked = null; st.error = null; return false; }
    st.supported = true;
    if (!res.ok || !res.data || typeof res.data.enabled !== 'boolean') { st.error = {text: SHIELD_READ_FAILED, detail: String((res && res.error) || '')}; return false; }
    st.error = null;
    st.enabled = res.data.enabled;
    st.masked = shieldCount(res.data.masked);
    return true;
  };
  const key = () => JSON.stringify([st.supported, st.enabled, st.masked, st.error, st.busy]);
  const self = {
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
      st.supported = null; st.serial++; st.loading = false; st.busy = false; st.error = null; st.enabled = null; st.masked = null;
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
      st.error = {text: SHIELD_SWITCH_FAILED, detail: String((res && res.error) || '')};
      return {ok: false};
    },
    /* Renderer: read on entry to Privacy, then every 5 s while it is open; repaint only on a change. */
    async refresh() {
      const now = h.gen ? h.gen() : null;
      if (gen !== now) { gen = now; self.reset(); }
      const before = key();
      await self.load();
      const shown = h.shown ? h.shown() : false;
      if (shown && key() !== before && h.render) h.render();
      if (!timer && shown && st.supported !== false) {
        timer = setTimeout(() => { timer = null; if (h.shown && h.shown()) self.refresh(); }, 5000);
      }
    },
    /* Renderer: `data-act="shield:<v>"`. */
    async act(v) {
      if (v === 'reload') { self.refresh(); return; }
      if (v !== 'toggle') return;
      const pending = self.toggle();
      if (h.render) h.render();
      const res = await pending;
      if (h.render) h.render();
      if (res && res.ok && h.toast) {
        h.toast(res.enabled ? 'Privacy Shield on' : 'Privacy Shield off',
          res.enabled ? 'Personal data and keys are masked before a cloud model sees them' : 'Cloud models get your messages as written');
      }
    },
  };
  return self;
}

/** The Privacy Shield row in Privacy, under Offline mode. deps: {esc}. */
function privacyShieldHTML(st, deps) {
  const {esc} = deps;
  const known = st.supported === true && typeof st.enabled === 'boolean';
  const on = known && st.enabled;
  const old = st.supported === false;
  let help = '';
  if (old) help = '<div class="tk-help set-shield-old">' + esc(SHIELD_OLD_AGENT) + '</div>';
  else if (known) help = '<div class="tk-help set-shield-count">' + esc(shieldCounterLine(st.masked) || SHIELD_NO_COUNTER) + '</div>';
  if (st.error && !old) {
    const said = typeof herrBodyHTML === 'function' ? herrBodyHTML(st.error) : esc(st.error.text || st.error);
    help += '<div class="tk-help tk-help--warn set-shield-err">' + said
      + ' <button class="set-link" data-act="shield:reload">Try again</button></div>';
  }
  const pending = !old && !known && !st.error;
  return '<div class="tk-setrow set-shield">'
    + '<div class="body"><div class="t">Privacy Shield</div>'
      + '<div class="d">When on, emails, phone numbers, card numbers, IBANs and keys are replaced with placeholders before a request goes to a cloud model, and put back in the answer on this computer. Local models see the real text.</div>'
      + help
    + '</div>'
    + (pending || st.busy ? '<span class="set-state" aria-hidden="true"><span class="tk-spin"></span></span>' : '')
    + '<button class="tk-switch' + (on ? ' on' : '') + '" role="switch" aria-checked="' + on + '" aria-label="Privacy Shield" data-act="shield:toggle"'
      + (!known || st.busy ? ' disabled' : '')
      + ' title="' + esc(old ? SHIELD_OLD_AGENT : 'Turn Privacy Shield ' + (on ? 'off' : 'on')) + '"></button>'
    + '</div>';
}

if (typeof module !== 'undefined') module.exports = {SHIELD_OLD_AGENT, SHIELD_NO_COUNTER, SHIELD_READ_FAILED, SHIELD_SWITCH_FAILED, shieldCounterLine, createPrivacyShield, privacyShieldHTML};
