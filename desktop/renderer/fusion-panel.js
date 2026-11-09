/* ---------------- ATO-568: the live subagent panel ----------------
   Loaded before renderer.js; declares only. Shared by the renderer and the
   Node checks (test/fusion-panel.test.mjs).

   The fan-out's live rows under the composer (fzLiveHTML) were read-only:
   the one Stop was the send button, and it stopped the whole turn. Each
   running worker row now carries two controls of its own:

     · Stop — cancels that worker alone. One click, no confirmation; the
       button stays disabled once pressed (the agent ends the row as
       `cancelled` with "stopped by the person", and the fan-out goes on).
     · Steer — opens a one-line field under the row. Enter sends the note
       to that worker alone; it reads it at its next step boundary, the
       same point a steer of the whole chat lands. Escape closes the field.

   Both go to the agent's `/api/sessions/{id}/fusion/workers/{taskId}/…`
   routes (agent PR for ATO-568), always addressed by the chat the fan-out
   runs in: a worker of another chat is never reached by its task id.

   Feature detection: the first worker frame of a chat asks
   `GET /api/sessions/{id}/fusion/workers` once. An agent from before those
   routes answers 404, and the rows stay exactly as they were, read-only.
   Only the actions the agent lists are drawn.

   The row's own extras ride beside the line fzLiveLine draws, never inside
   it: tokens and $ when the agent sends them (`tokens`, `spent_usd` on the
   usage frame), and a "stuck" mark on the TUI's rule (isFusionWorkerStuck:
   twice the expected time and at least three minutes) or after the agent
   escalated the worker because it stalled. */

const FZP = {
  /** sessionId → {actions: string[], at: ms} once the agent answered (or refused). */
  support: {},
  /** sessionIds with a probe in flight. */
  probing: {},
  /** The row whose Steer field is open: its key, or null. */
  open: null,
  /** What is typed in that field, so a repaint keeps it. */
  draft: '',
  /** key → 'stop' | 'steer' while that request is in flight. */
  busy: {},
  /** key → true once Stop went through: the button stays disabled. */
  stopped: {},
  /** key → {text, bad, at}: the row's last outcome, shown for a few seconds. */
  note: {},
  /** Set by the renderer: focus the open field on the next paint. */
  wantFocus: false,
};

/** How long a refused probe waits before a later frame may ask again. */
const FZP_REPROBE_MS = 60_000;
/** How long a row's outcome line stays. */
const FZP_NOTE_MS = 6_000;
/** isFusionWorkerStuck (src/tui/fusion-live-workers.ts). */
const FZP_STUCK_MULTIPLE = 2;
const FZP_MIN_STUCK_MS = 3 * 60_000;
const FZP_MIN_FINISHED_SIBLINGS = 2;
const FZP_MAX_CORRECTION = 20;

function fzpEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
}

/** One worker's key: the chat it runs in and its task id. */
function fzpKey(sessionId, taskId) {
  return String(sessionId || '') + '\u0000' + String(taskId || '');
}

/** The actions the agent listed for this chat's workers; [] when unknown or refused. */
function fzpActions(state, sessionId) {
  const s = sessionId ? state.support[sessionId] : null;
  return s && Array.isArray(s.actions) ? s.actions : [];
}

/**
 * Should a frame for `sessionId` start a probe? Once per chat, and again
 * only after a refusal has aged (an agent restarted onto a newer build).
 */
function fzpNeedsProbe(state, sessionId, now) {
  if (!sessionId || state.probing[sessionId]) return false;
  const s = state.support[sessionId];
  if (!s) return true;
  return s.actions.length === 0 && now - s.at >= FZP_REPROBE_MS;
}

/**
 * The list route's answer, reduced to the actions this panel draws. An
 * agent without the route (404, "no route") or any failure is [].
 */
function fzpActionsFromList(res) {
  if (!res || res.ok !== true || !Array.isArray(res.actions)) return [];
  return res.actions.filter((a) => a === 'stop' || a === 'steer');
}

/** ` · 41.2k tok · $0.031`, or less of it when that is all that is known (describeSpend). */
function fzpSpendText(w) {
  const tokens = typeof w.tokens === 'number' && w.tokens > 0 ? ' · ' + fzpTokens(w.tokens) + ' tok' : '';
  const usd = typeof w.spentUsd === 'number' && Number.isFinite(w.spentUsd)
    ? ' · $' + (w.spentUsd > 0 && w.spentUsd < 0.01 ? w.spentUsd.toFixed(4) : w.spentUsd.toFixed(2))
    : '';
  return tokens + usd;
}

function fzpTokens(n) {
  if (n < 1000) return String(n);
  if (n < 1e6) { const k = n / 1000; return Number.isInteger(k) ? k + 'k' : k.toFixed(1) + 'k'; }
  const m = n / 1e6; return Number.isInteger(m) ? m + 'M' : m.toFixed(1) + 'M';
}

function fzpMedian(xs) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * The TUI's stuck rule, on the desktop's rows: a running leg past twice
 * what it was expected to take and past three minutes. The expectation is
 * the orchestrator's estimate (corrected by how its finished siblings ran)
 * or, with no estimate, the finished siblings' median once at least two
 * have finished. No expectation, no flag. A leg the agent escalated for a
 * stall is stuck by the agent's own measure.
 */
function fzpIsStuck(w, workers, now) {
  if (!w || w.done) return false;
  if (w.stalled) return true;
  if (!w.startedAt) return false;
  const ratios = [], times = [];
  for (const x of workers || []) {
    if (!x.done || !x.finishedAt || !x.startedAt) continue;
    const ms = x.finishedAt - x.startedAt;
    if (ms <= 0) continue;
    times.push(ms);
    if (x.etaSeconds) ratios.push(ms / 1000 / x.etaSeconds);
  }
  let expectedMs = null;
  if (w.etaSeconds) {
    const r = fzpMedian(ratios);
    const correction = r !== null && Number.isFinite(r) && r > 0 ? Math.min(r, FZP_MAX_CORRECTION) : 1;
    expectedMs = w.etaSeconds * 1000 * correction;
  } else if (times.length >= FZP_MIN_FINISHED_SIBLINGS) {
    expectedMs = fzpMedian(times);
  }
  if (!expectedMs) return false;
  const elapsed = (now || Date.now()) - w.startedAt;
  return elapsed >= expectedMs * FZP_STUCK_MULTIPLE && elapsed >= FZP_MIN_STUCK_MS;
}

/**
 * The controls and extras for one live row, as HTML. `state` is FZP (a copy
 * in tests); `now` is the clock. A done row gets no control: nothing is left
 * to act on.
 */
function fzpRowExtrasHTML(w, workers, state, now) {
  const spend = fzpSpendText(w);
  const stuck = fzpIsStuck(w, workers, now);
  let out = '';
  if (spend) out += '<span class="fzspend">' + fzpEsc(spend.replace(/^ · /, '')) + '</span>';
  if (stuck) out += '<span class="fzstuck" title="This worker has run much longer than expected">stuck</span>';
  if (w.done || !w.sessionId) return out;
  const actions = fzpActions(state, w.sessionId);
  if (!actions.length) return out;
  const key = fzpKey(w.sessionId, w.taskId);
  const id = encodeURIComponent(w.taskId);
  const label = fzpEsc(w.title || w.taskId);
  const busy = state.busy[key];
  out += '<span class="fzctl">';
  if (actions.includes('steer')) {
    const open = state.open === key;
    out += '<button type="button" class="fzbtn' + (open ? ' on' : '') + '" data-act="fzp:steer:' + id + '"'
      + ' aria-expanded="' + open + '" aria-label="Steer worker ' + label + '"'
      + (state.stopped[key] ? ' disabled' : '') + '>Steer</button>';
  }
  if (actions.includes('stop')) {
    const done = !!state.stopped[key];
    out += '<button type="button" class="fzbtn" data-act="fzp:stop:' + id + '"'
      + ' aria-label="Stop worker ' + label + '"'
      + (done || busy === 'stop' ? ' disabled' : '') + '>'
      + (done ? 'Stopped' : busy === 'stop' ? 'Stopping…' : 'Stop') + '</button>';
  }
  out += '</span>';
  return out;
}

/** The inline Steer field under a row, or ''. */
function fzpSteerFieldHTML(w, state) {
  if (w.done || !w.sessionId) return '';
  const key = fzpKey(w.sessionId, w.taskId);
  if (state.open !== key || !fzpActions(state, w.sessionId).includes('steer')) return '';
  const label = fzpEsc(w.title || w.taskId);
  const sending = state.busy[key] === 'steer';
  return '<div class="fzsteer">'
    + '<label class="fzsteer-lb" for="fzp-steer-field">Note for ' + label + '</label>'
    + '<input id="fzp-steer-field" class="fzsteer-in" type="text" data-fzp-steer="' + encodeURIComponent(w.taskId) + '"'
    + ' value="' + fzpEsc(state.draft) + '" placeholder="Tell this worker something; Enter sends, Esc closes"'
    + ' autocomplete="off" spellcheck="true"' + (sending ? ' disabled' : '') + '>'
    + '</div>';
}

/** The row's last outcome ("Note sent", "Already finished"), or ''. */
function fzpNoteHTML(w, state, now) {
  if (!w.sessionId) return '';
  const n = state.note[fzpKey(w.sessionId, w.taskId)];
  if (!n || (now || Date.now()) - n.at > FZP_NOTE_MS) return '';
  return '<div class="fznote' + (n.bad ? ' bad' : '') + '" role="status">' + fzpEsc(n.text) + '</div>';
}

/**
 * What the agent's answer to a steer means for the row. The agent's 404 and
 * 409 sentences are written for an API client; the row says it plainly.
 */
function fzpSteerOutcome(res) {
  if (res && res.ok === true && res.steered === true) {
    return {ok: true, text: 'Note sent. The worker reads it at its next step.'};
  }
  const err = String((res && res.error) || '');
  if (/is not running|no fusion worker/i.test(err)) return {ok: false, gone: true, text: 'This worker has already finished.'};
  if (/not taking notes|inbox is full/i.test(err)) return {ok: false, text: 'The worker is finishing or busy. Try again in a moment.'};
  if (/no route|HTTP 404/i.test(err)) return {ok: false, unsupported: true, text: 'This agent cannot steer one worker. Update the agent.'};
  return {ok: false, text: 'Could not send the note' + (err ? ': ' + err : '.')};
}

function fzpStopOutcome(res) {
  if (res && res.ok === true && res.stopped === true) return {ok: true, text: 'Stopping this worker. The others carry on.'};
  const err = String((res && res.error) || '');
  if (/is not running|no fusion worker/i.test(err)) return {ok: false, gone: true, text: 'This worker has already finished.'};
  if (/no route|HTTP 404/i.test(err)) return {ok: false, unsupported: true, text: 'This agent cannot stop one worker. Update the agent.'};
  return {ok: false, text: 'Could not stop the worker' + (err ? ': ' + err : '.')};
}

/* ---------------- the browser half ---------------- */

/** The live row for a task id in the open chat. */
function fzpRow(taskId) {
  return typeof FZ !== 'undefined' ? FZ.live.find((w) => w.taskId === taskId) : null;
}

function fzpSay(key, outcome) {
  FZP.note[key] = {text: outcome.text, bad: !outcome.ok, at: Date.now()};
  setTimeout(() => { if (typeof render === 'function') render(); }, FZP_NOTE_MS + 50);
}

/** A worker frame arrived: ask the agent once per chat what it supports. */
function fzpNoteFrame(e) {
  if (!e || e.role === 'orchestrator' || !e.sessionId) return;
  if (!fzpNeedsProbe(FZP, e.sessionId, Date.now())) return;
  const bridge = typeof BR !== 'undefined' ? BR : null;
  if (!bridge || typeof bridge.fusionWorkersList !== 'function') {
    FZP.support[e.sessionId] = {actions: [], at: Date.now()};
    return;
  }
  const sid = e.sessionId;
  FZP.probing[sid] = true;
  Promise.resolve(bridge.fusionWorkersList(sid)).then((res) => {
    FZP.support[sid] = {actions: fzpActionsFromList(res), at: Date.now()};
  }, () => {
    FZP.support[sid] = {actions: [], at: Date.now()};
  }).finally(() => {
    delete FZP.probing[sid];
    if (typeof render === 'function') render();
  });
}

/** `fzp:<verb>:<encoded task id>` from a row's button. */
function fzpAct(v) {
  const colon = String(v || '').indexOf(':');
  if (colon < 0) return;
  const verb = v.slice(0, colon);
  const taskId = decodeURIComponent(v.slice(colon + 1));
  const w = fzpRow(taskId);
  if (!w || w.done || !w.sessionId) return;
  const key = fzpKey(w.sessionId, taskId);
  if (verb === 'steer') {
    if (FZP.open === key) { FZP.open = null; FZP.draft = ''; }
    else { FZP.open = key; FZP.draft = ''; FZP.wantFocus = true; }
    render();
    return;
  }
  if (verb === 'stop') fzpStop(w, key);
}

function fzpStop(w, key) {
  if (FZP.busy[key] || FZP.stopped[key] || !BR || typeof BR.fusionWorkerStop !== 'function') return;
  FZP.busy[key] = 'stop';
  if (FZP.open === key) { FZP.open = null; FZP.draft = ''; }
  render();
  Promise.resolve(BR.fusionWorkerStop(w.sessionId, w.taskId)).catch((err) => ({ok: false, error: String(err && err.message || err)}))
    .then((res) => {
      delete FZP.busy[key];
      const out = fzpStopOutcome(res);
      // Disabled for good once it went through, and when the worker is gone anyway.
      if (out.ok || out.gone) FZP.stopped[key] = true;
      fzpSay(key, out);
      render();
    });
}

function fzpSendSteer(field) {
  const taskId = decodeURIComponent(field.dataset.fzpSteer || '');
  const w = fzpRow(taskId);
  const text = String(field.value || '').trim();
  if (!w || !w.sessionId || !text) return;
  const key = fzpKey(w.sessionId, taskId);
  if (FZP.busy[key] || !BR || typeof BR.fusionWorkerSteer !== 'function') return;
  FZP.busy[key] = 'steer';
  FZP.draft = text;
  render();
  Promise.resolve(BR.fusionWorkerSteer(w.sessionId, taskId, text)).catch((err) => ({ok: false, error: String(err && err.message || err)}))
    .then((res) => {
      delete FZP.busy[key];
      const out = fzpSteerOutcome(res);
      // Sent: the field closes. Refused: it stays with the text, to send again or close.
      if (out.ok || out.gone || out.unsupported) {
        if (FZP.open === key) { FZP.open = null; FZP.draft = ''; }
      } else {
        FZP.wantFocus = true;
      }
      fzpSay(key, out);
      render();
    });
}

/** Enter sends, Escape closes. True when the key was the field's. */
function fzpKeydown(e) {
  const field = e.target;
  if (!field || !field.dataset || field.dataset.fzpSteer === undefined) return false;
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); fzpSendSteer(field); return true; }
  if (e.key === 'Escape') { e.preventDefault(); FZP.open = null; FZP.draft = ''; render(); return true; }
  return false;
}

/** The field's text, kept for the next repaint. */
function fzpInput(e) {
  if (!e.target || !e.target.dataset || e.target.dataset.fzpSteer === undefined) return false;
  FZP.draft = e.target.value;
  return true;
}

/** After a render: put the caret in a field that was just opened or refused. */
function fzpAfterRender() {
  if (!FZP.wantFocus) return;
  const f = document.getElementById('fzp-steer-field');
  if (!f || f.disabled) return;
  FZP.wantFocus = false;
  if (document.activeElement !== f) { f.focus(); try { f.setSelectionRange(f.value.length, f.value.length); } catch (e) { /* fine */ } }
}

/**
 * The once-a-second clock repaint, without throwing the field away: the
 * strip is morphed (dom-morph.js), so the input keeps its node, its text
 * and its caret while the clocks move.
 */
function fzpRepaintStrip(el) {
  const tpl = document.createElement('template');
  tpl.innerHTML = fzLiveHTML();
  const fresh = tpl.content.firstElementChild;
  if (!fresh) { el.remove(); return; }
  if (typeof morphChildren !== 'function' || typeof morphAttributes !== 'function') { el.outerHTML = fzLiveHTML(); return; }
  morphAttributes(el, fresh);
  morphChildren(el, fresh);
}

if (typeof window !== 'undefined') {
  /* --smoke: the panel's markup for seeded rows and a seeded support answer,
     without a fan-out or an agent. */
  window.__fzpPanelProbe = (rows, actions) => {
    const keep = {support: FZP.support, live: FZ.live, busy: S.busy};
    try {
      FZP.support = {};
      (rows || []).forEach((r) => { if (r.sessionId) FZP.support[r.sessionId] = {actions: actions || [], at: Date.now()}; });
      FZ.live = rows || []; S.busy = true;
      const tpl = document.createElement('template');
      tpl.innerHTML = fzLiveHTML();
      return Array.from(tpl.content.querySelectorAll('.fzw')).map((n) => ({
        text: (n.querySelector('.fzt') || {}).textContent || '',
        buttons: Array.from(n.querySelectorAll('button')).map((b) => ({label: b.textContent, aria: b.getAttribute('aria-label'), disabled: b.disabled})),
        spend: (n.querySelector('.fzspend') || {}).textContent || '',
        stuck: !!n.querySelector('.fzstuck'),
      }));
    } finally {
      FZP.support = keep.support; FZ.live = keep.live; S.busy = keep.busy;
    }
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    FZP, FZP_REPROBE_MS, FZP_NOTE_MS, fzpKey, fzpNeedsProbe, fzpActionsFromList, fzpSpendText, fzpIsStuck,
    fzpRowExtrasHTML, fzpSteerFieldHTML, fzpNoteHTML, fzpSteerOutcome, fzpStopOutcome,
  };
}
