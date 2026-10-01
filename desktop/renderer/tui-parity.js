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
  /* Item 29: this looked the picked provider up in selProviders(), which
     leaves the llama-server entries out, so it never found the local one and
     the local server's status line below never showed on the local route.
     No `llm` block at all is the local route too: the agent synthesizes
     local-llama. */
  if (LIVE_CONFIG && !LIVE_CONFIG.llm) return true;
  const id = selActiveProviderId();
  return !!id && waitIsLocalServer(id);
}

function tpWaitNotice(wait) {
  // Item 29: waitWhy is the agent's cause when it sent one, else its reason as before.
  const why = waitWhy(wait);
  const budget = wait && wait.maxWaitMs ? ' for up to ' + tpSeconds(wait.maxWaitMs) : '';
  // Item 29: an agent that names the provider it waits on gets it named here.
  const who = wait && wait.providerId ? 'No answer from ' + waitProviderName(wait.providerId) : 'The model isn’t answering';
  return who + (why ? ' (' + why + ')' : '') + '. The turn is paused and retries on its own'
    + budget + '. Stop ends it.';
}

/** `atag models status` in one sentence, or '' when the server looks fine.
    `said`: the notice above already says the server is not running, so only the way out is left to add. */
function tpLocalServerLine(st, said) {
  if (!st) return '';
  if (st.fault) return 'Local model server: ' + st.fault;
  if (st.mode === 'managed' && !st.daemonRunning) return said ? 'Start it in Settings › Models.' : 'The local model server isn’t running. Start it in Settings › Models.';
  return '';
}

/** First provider_waiting frame of a wait. */
function tpOnProviderWaiting(wait) {
  placeInLiveTurn({id:nid(), k:'system', sev:'pause', note:true, text: esc(tpWaitNotice(wait))});
  // Item 29: the local server is asked about when the wait is on it, whichever provider was picked.
  const onLocal = wait && wait.providerId ? waitIsLocalServer(wait.providerId) : tpActiveIsLocal();
  if (!BR || !BR.modelsStatus || !onLocal) return;
  const said = !!(wait && wait.providerId && wait.cause && wait.cause.kind === 'refused');
  const turnId = S.turnId;
  const streamId = S.streamId;
  BR.modelsStatus().then((res) => {
    const line = tpLocalServerLine(res && res.ok ? res.status : null, said);
    // Only while the same turn is still the one on screen (switching chats keeps S.turnId but swaps S.log).
    if (!line || S.turnId !== turnId || S.streamId !== streamId || !S.log.some((m) => m.id === streamId)) return;
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

/* ---- Fusion: how long each worker has run (src/tui/fusion-live-workers.ts) --
   Four rows of "working" look the same at ten seconds and at ten minutes. The
   TUI keeps a clock per leg and prints it beside the orchestrator's estimate
   (`eta_seconds` on the fusion_worker frame), corrected by how far off the
   finished legs of the same wave were; a leg with no estimate is compared to
   the median of its finished siblings. The estimate is dropped once the leg
   is done, and turns into "past the ~2m expected" once elapsed passes it. */
const TP_FZ_MAX_CORRECTION = 20;

/** `1m04s`, `12s` (fusion-live-workers.ts formatElapsed). */
function tpElapsed(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (s < 60) return s + 's';
  return Math.floor(s / 60) + 'm' + String(s % 60).padStart(2, '0') + 's';
}

function tpMedian(xs) {
  if (!xs.length) return null;
  const v = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** fanoutExpectation: median actual/estimate, and median finished duration. */
function tpFzExpectation(workers) {
  const ratios = [], times = [];
  for (const w of workers) {
    if (!w.done || !w.finishedAt || !w.startedAt) continue;
    const ms = w.finishedAt - w.startedAt;
    if (ms <= 0) continue;
    times.push(ms);
    if (w.etaSeconds) ratios.push(ms / 1000 / w.etaSeconds);
  }
  const r = tpMedian(ratios);
  return {
    correction: r !== null && Number.isFinite(r) && r > 0 ? Math.min(r, TP_FZ_MAX_CORRECTION) : null,
    medianMs: tpMedian(times),
  };
}

/** ` · 42s (~2m expected)` for one leg; '' before the clock has started. */
function tpFzTiming(w, workers, now) {
  if (!w.startedAt) return '';
  const elapsedMs = (w.finishedAt || now || Date.now()) - w.startedAt;
  let out = ' · ' + tpElapsed(elapsedMs);
  if (w.done) return out;
  const m = tpFzExpectation(workers || []);
  const expectedMs = w.etaSeconds ? w.etaSeconds * 1000 * (m.correction || 1) : m.medianMs;
  if (!expectedMs) return out;
  return out + (elapsedMs >= expectedMs ? ' (past the ~' + tpElapsed(expectedMs) + ' expected)' : ' (~' + tpElapsed(expectedMs) + ' expected)');
}

/** The per-leg clock, the fields fzReduceLive keeps beside its own. */
function tpFzClock(prev, e, done, now) {
  const t = now || Date.now();
  return {
    startedAt: (prev && prev.startedAt) || t,
    finishedAt: done ? ((prev && prev.finishedAt) || t) : null,
    etaSeconds: (typeof e.etaSeconds === 'number' && e.etaSeconds > 0 ? e.etaSeconds : null) || (prev && prev.etaSeconds) || null,
  };
}

/* One tick a second while a leg is running: the clocks repaint in place. */
let TP_FZ_TICK = 0;
function tpFzEnsureTick() {
  if (TP_FZ_TICK) return;
  TP_FZ_TICK = setInterval(() => {
    const running = FZ.live.some((w) => !w.done) && (S.busy || S.pending);
    if (!running) { clearInterval(TP_FZ_TICK); TP_FZ_TICK = 0; return; }
    const el = document.querySelector('.fzlive');
    if (el) el.outerHTML = fzLiveHTML();
  }, 1000);
}

/* ---- Skills left out of the prompt (/api/capabilities skillsOmitted) -------
   Config v70 caps the skill list the agent sees at skills.catalogTokenBudget;
   what does not fit is left out of the prompt, and /api/capabilities reports
   how many (always present, 0 when all fit). The Skills tab says so in one
   line, so "12 enabled" is not read as 12 skills the agent knows about. */
const TP_SK = { omitted: null, busy: false };

function tpSkillsOmitted() {
  if (typeof TP_SK.omitted === 'number') return TP_SK.omitted;
  const n = LIVE_CAPS && typeof LIVE_CAPS.skillsOmitted === 'number' ? LIVE_CAPS.skillsOmitted : 0;
  return n;
}

/** Re-read the count: it changes when skills are installed, removed or toggled. */
async function tpSkillsOmittedRefresh() {
  if (!BR || !BR.capabilities || TP_SK.busy) return;
  TP_SK.busy = true;
  try {
    const before = tpSkillsOmitted();
    const caps = await BR.capabilities();
    const n = caps && caps.ok && caps.data ? caps.data.skillsOmitted : undefined;
    if (typeof n === 'number') TP_SK.omitted = n;
    if (tpSkillsOmitted() !== before && skillsVisible()) skpRender();
  } catch (err) {
    // An older agent, or none: nothing to say.
  } finally {
    TP_SK.busy = false;
  }
}

function tpSkillsOmittedHTML() {
  const n = tpSkillsOmitted();
  if (!n) return '';
  return '<div class="tk-help set-skomit">' + ic('info') + '<span>' + n + ' skill' + (n === 1 ? '' : 's')
    + ' left out of the agent’s prompt: the skill list is over its size budget (<span class="mono">skills.catalogTokenBudget</span>).</span></div>';
}
