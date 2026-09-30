"use strict";

/* TUI parity (v0.6.7): what the terminal UI already shows, brought to the
   window. Loaded before renderer.js; everything here is read at call time,
   so it may use renderer.js globals (BR, esc, ic, render, S, …) freely.
   Names carry a `tp` prefix so they never collide with renderer.js. */

/* ---- End-of-turn notification (tui.notify, config v71) ------------------
   The notification itself is raised by the main process (main/turn-notify.ts)
   from the same key the TUI reads. This is the Settings › General row that
   switches it. */
const TP_NOTIFY = { loaded: false, loading: false, enabled: null, minMs: 30000, busy: false, error: null };

async function tpNotifyLoad() {
  if (!BR || !BR.configGetKey || TP_NOTIFY.loading) return;
  TP_NOTIFY.loading = true;
  try {
    const res = await BR.configGetKey('tui.notify');
    if (res && res.ok && res.value && typeof res.value === 'object') {
      TP_NOTIFY.enabled = res.value.enabled !== false;
      const ms = Number(res.value.minDurationMs);
      if (Number.isFinite(ms) && ms >= 0) TP_NOTIFY.minMs = ms;
      TP_NOTIFY.error = null;
    } else {
      TP_NOTIFY.error = (res && res.error) || 'could not read this setting';
    }
  } finally {
    TP_NOTIFY.loading = false;
    TP_NOTIFY.loaded = true;
  }
}

async function tpNotifyToggle() {
  if (!BR || TP_NOTIFY.busy || typeof TP_NOTIFY.enabled !== 'boolean') return;
  const next = !TP_NOTIFY.enabled;
  TP_NOTIFY.busy = true; TP_NOTIFY.error = null; render();
  try {
    const res = await BR.configSet('tui.notify.enabled', String(next));
    if (!res || res.ok === false) TP_NOTIFY.error = 'Couldn’t save: ' + ((res && res.error) || 'unknown error');
    await tpNotifyLoad();
  } finally {
    TP_NOTIFY.busy = false; render();
  }
}

/** `30 s`, `2 min` — the notify threshold and the wait budgets. */
function tpSeconds(ms) {
  const s = Math.max(1, Math.round((Number(ms) || 0) / 1000));
  return s < 120 ? s + ' s' : Math.round(s / 60) + ' min';
}

/** The General pane's row. The first draw starts the read and repaints when it lands. */
function tpNotifyRowHTML() {
  if (!TP_NOTIFY.loaded && !TP_NOTIFY.loading && BR) {
    setTimeout(() => { tpNotifyLoad().then(() => { if (S.settings) render(); }); }, 0);
  }
  const known = typeof TP_NOTIFY.enabled === 'boolean';
  const on = known && TP_NOTIFY.enabled;
  const pending = !known && (TP_NOTIFY.loading || !TP_NOTIFY.loaded);
  return '<div class="tk-setrow">'
    + '<div class="body"><div class="t">Notify when a turn ends</div>'
      + '<div class="d">While the window is in the background. Always on failure; on success after '
        + esc(tpSeconds(TP_NOTIFY.minMs)) + ' or more.</div>'
      + (TP_NOTIFY.error ? '<div class="tk-help tk-help--warn">' + esc(TP_NOTIFY.error) + '</div>' : '')
    + '</div>'
    + '<span class="set-state' + (on ? ' on' : '') + '" aria-hidden="true">' + (TP_NOTIFY.busy || pending ? '<span class="tk-spin"></span>' : esc(known ? (on ? 'On' : 'Off') : '—')) + '</span>'
    + '<button class="tk-switch' + (on ? ' on' : '') + '" role="switch" aria-checked="' + on + '" aria-label="Notify when a turn ends" data-act="notify:toggle"'
      + (!known || TP_NOTIFY.busy ? ' disabled' : '') + ' title="Turn notifications ' + (on ? 'off' : 'on') + '"></button>'
    + '</div>';
}

/* ---- Why the agent went quiet (agent v0.6.6) -----------------------------
   A turn parked on a model that stopped answering already draws the waiting
   strip above the composer (provider_waiting / provider_recovered frames).
   The strip goes away with the wait, so the transcript kept no trace of it
   and, while it lasted, did not say what happens next. The TUI posts one
   calm line when the wait starts, one when the model is back, and a lead
   line when the turn gives up (src/tui/format-provider-outage.ts); these
   are the same three, in the window's words.

   The TUI's other notices (the managed server crashed, restarting, back up)
   come from its own daemon supervisor, which `atag serve` does not run. On
   the local route the window asks `atag models status` instead and says
   what it finds: a server that is not running, or the fault its log shows. */

function tpActiveIsLocal() {
  const id = selActiveProviderId();
  const entry = (selProviders() || []).find((p) => p.id === id);
  return !!entry && entry.kind === 'llama-server';
}

function tpWaitNotice(wait) {
  const why = wait && wait.reason ? humanWaitReason(wait.reason) : '';
  const budget = wait && wait.maxWaitMs ? ' for up to ' + tpSeconds(wait.maxWaitMs) : '';
  return 'The model isn’t answering' + (why ? ' (' + why + ')' : '') + '. The turn is paused and retries on its own'
    + budget + '. Stop ends it.';
}

/** `atag models status` in one sentence, or '' when the server looks fine. */
function tpLocalServerLine(st) {
  if (!st) return '';
  if (st.fault) return 'Local model server: ' + st.fault;
  if (st.mode === 'managed' && !st.daemonRunning) return 'The local model server isn’t running. Start it in Settings › Models.';
  return '';
}

/** First provider_waiting frame of a wait. */
function tpOnProviderWaiting(wait) {
  placeInLiveTurn({id:nid(), k:'system', sev:'pause', note:true, text: esc(tpWaitNotice(wait))});
  if (!BR || !BR.modelsStatus || !tpActiveIsLocal()) return;
  const turnId = S.turnId;
  BR.modelsStatus().then((res) => {
    const line = tpLocalServerLine(res && res.ok ? res.status : null);
    // Only while the same turn is still the one on screen.
    if (!line || S.turnId !== turnId) return;
    placeInLiveTurn({id:nid(), k:'system', sev:'warn', note:true, text: esc(line)});
    render();
  }).catch(() => {});
}

function tpOnProviderRecovered(waitedMs) {
  placeInLiveTurn({id:nid(), k:'system', note:true,
    text: esc('The model is answering again after ' + tpSeconds(waitedMs) + '. The turn continues.')});
}

/** Put before the failure a turn ends with while it was parked. */
function tpWaitGaveUpEntry(wait) {
  return {id:nid(), k:'system', sev:'pause', note:true,
    text: esc('Stopped waiting for the model' + (wait && wait.maxWaitMs ? ' after ' + tpSeconds(wait.maxWaitMs) : '') + '.')};
}

/* ---- Providers the fallback chain tried (fallback_failures) ---------------
   When the active provider fails and the fallback chain falls over, the
   agent's error frame names the FIRST link (the provider the person picked)
   and lists every link that failed before the last one in
   `fallback_failures: [{providerId, reason}]`. The last link's own error is
   not in the frame. The list sits under the error row, collapsed; the row's
   entry keeps `open`, so the shared [data-toggle] handler folds it. */

/** The frame's list, cleaned; [] when there was no fallover. */
function tpFallbackFailures(payload) {
  const raw = payload && Array.isArray(payload.fallback_failures) ? payload.fallback_failures : [];
  return raw
    .filter((f) => f && typeof f.providerId === 'string' && f.providerId)
    .map((f) => ({providerId: f.providerId, reason: typeof f.reason === 'string' ? f.reason : ''}));
}

function tpTriedHTML(m) {
  const list = m.tried || [];
  if (!list.length) return '';
  const head = '<button class="sys-tried-t" data-toggle="' + m.id + '" aria-expanded="' + (!!m.open) + '">'
    + ic(m.open ? 'chevD' : 'chevR') + '<span>Providers tried</span> <span class="disc-n">· ' + (list.length + 1) + '</span></button>';
  if (!m.open) return '<span class="sys-tried">' + head + '</span>';
  return '<span class="sys-tried">' + head + '<span class="sys-tried-l">'
    + list.map((f) => '<span class="sys-tried-i"><b>' + esc(providerWord(f.providerId) || f.providerId) + '</b> '
      + esc(f.reason || 'failed') + '</span>').join('')
    + '<span class="sys-tried-i">then the last fallback, which failed too</span>'
    + '</span></span>';
}

/* ---- Local server fault (atag models status `fault:`, agent 0.6.6) --------
   `health: ok` only means the socket answers. A server that ran out of GPU
   memory keeps its socket and fails every request; `models status` now reads
   the server's own log (current run only) and prints one `fault:` line. The
   Models section shows it under the "now answering" line, with the log. */
function tpLlmFault() {
  const st = typeof LLMP !== 'undefined' ? LLMP.status : null;
  return st && st.fault ? String(st.fault) : '';
}

function tpLlmFaultHTML() {
  const fault = tpLlmFault();
  if (!fault) return '';
  return '<div class="tk-notice tk-notice--amber llm-fault">' + ic('alert')
    + '<span class="grow"><b>Local model server problem.</b> ' + esc(fault) + '</span>'
    + '<button class="btn btn-s sm" data-act="llm:logs">LLM logs</button></div>';
}
