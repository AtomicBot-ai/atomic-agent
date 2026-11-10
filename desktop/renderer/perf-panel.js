/* ---------------- Settings › Performance (issue #996) ----------------
   Loaded before renderer.js; declares only. Shared by the renderer and the
   Node checks (test/perf-panel.test.mjs).

   How fast the LOCAL model answers: generation and prompt speed, time to
   first token, how many requests shared the GPU, and how much context the
   newest request used, with two small charts over the recent requests so a
   person can see whether a change (model, quantization, context size,
   worker count) made things faster or slower.

   The numbers are the agent's: `GET /api/local-model/performance` keeps one
   sample per completed request to the local model server (the newest 300,
   in memory, gone when the agent restarts) and reads the server's `/slots`.
   Main answers the renderer with `{ok:true, data}`, `{ok:false,
   kind:'unsupported'}` (an agent from before the route: 404) or
   `{ok:false, kind:'unreachable', error}`.

   The pane polls every 2 s only while it is on screen, one request at a
   time. Every enter, leave and agent restart moves a generation counter;
   an answer for an older generation is dropped unseen. An older agent stops
   the poll until the pane is opened again, which asks once more (the agent
   may have been updated meanwhile). */

const PERF_POLL_MS = 2000;
const PERF_CHART = {width: 520, height: 96};

/* renderer.js's `esc` is not visible from here; the same mapping, plus '. */
function perfEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
}

function perfNum(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

function perfMean(xs) {
  const ok = xs.map(perfNum).filter((v) => v !== null);
  if (!ok.length) return null;
  const m = ok.reduce((a, b) => a + b, 0) / ok.length;
  return Number.isFinite(m) ? m : null;
}

/** Only the sample objects of whatever the agent sent. */
function perfSamples(samples) {
  return Array.isArray(samples) ? samples.filter((s) => s && typeof s === 'object') : [];
}

/**
 * The numbers the rows show. `last` is the NEWEST sample's value even when
 * it is null (a fully cached prompt has no prompt speed, and an older speed
 * would be a wrong answer); `mean` is over the samples that have one.
 */
function perfSummary(samples, slots) {
  const xs = perfSamples(samples);
  const newest = xs.length ? xs[xs.length - 1] : null;
  const pick = (k) => ({last: newest ? perfNum(newest[k]) : null, mean: perfMean(xs.map((s) => s[k]))});
  const conc = xs.map((s) => perfNum(s.concurrent)).filter((v) => v !== null);
  return {
    count: xs.length,
    generation: pick('generationPerSecond'),
    prompt: pick('promptPerSecond'),
    ttft: pick('ttftMs'),
    context: {
      lastTokens: newest ? perfNum(newest.contextTokens) : null,
      perSlot: slots && typeof slots === 'object' ? perfNum(slots.contextPerSlot) : null,
    },
    concurrent: {last: newest ? perfNum(newest.concurrent) : null, max: conc.length ? Math.max(...conc) : null},
  };
}

function perfInt(n) { return Math.round(n).toLocaleString('en-US'); }

/** `54 tok/s`, `1,450 tok/s`; one decimal under 10 so a slow model still reads; `—` when unknown. */
function perfFormatRate(n) {
  const v = perfNum(n);
  if (v === null) return '—';
  return (Math.abs(v) < 10 ? String(Math.round(v * 10) / 10) : perfInt(v)) + ' tok/s';
}

/** `412 ms` under a second, `2.4 s` above; `—` when unknown. */
function perfFormatMs(n) {
  const v = perfNum(n);
  if (v === null) return '—';
  return Math.round(v) < 1000 ? perfInt(v) + ' ms' : (v / 1000).toFixed(1) + ' s';
}

/** `146 / 262,144`; bare `146` when the context size is unknown; `—` with no count. */
function perfFormatContext(tokens, perSlot) {
  const t = perfNum(tokens);
  if (t === null) return '—';
  const p = perfNum(perSlot);
  return p === null ? perfInt(t) : perfInt(t) + ' / ' + perfInt(p);
}

function perfClock(at) {
  const v = perfNum(at);
  if (v === null) return '—';
  const d = new Date(v);
  const two = (n) => String(n).padStart(2, '0');
  return two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds());
}

function perfCoord(n) {
  const v = Math.round(n * 10) / 10;
  return String(Number.isFinite(v) ? v : 0);
}

/**
 * One series over the sample index, as an inline <svg>. A missing or
 * non-finite value breaks the line (never a dip to zero); a change of model
 * draws a vertical tick naming the new one; every point carries a tooltip
 * with its time, value and how many requests were running at once.
 */
function perfChartSVG(samples, key, size) {
  const xs = perfSamples(samples);
  // A size outside 1..10000 falls back to the default, so no coordinate overflows.
  const dim = (v, d) => { const n = perfNum(v); return n !== null && n >= 1 && n <= 10000 ? n : d; };
  const w = dim(size && size.width, PERF_CHART.width);
  const h = dim(size && size.height, PERF_CHART.height);
  const pad = 6;
  const vals = xs.map((s) => { const v = perfNum(s[key]); return v !== null && v >= 0 ? v : null; });
  const top = Math.max(0, ...vals.filter((v) => v !== null));
  const scale = top > 0 ? top * 1.1 : 1;
  const step = xs.length > 1 ? (w - 2 * pad) / (xs.length - 1) : 0;
  const xAt = (i) => (xs.length > 1 ? pad + i * step : w / 2);
  const yAt = (v) => h - pad - (v / scale) * (h - 2 * pad);
  const unit = perfFormatRate;
  let out = '<svg class="perf-chart" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="'
    + perfEsc(key === 'promptPerSecond' ? 'Prompt speed over recent requests' : 'Generation speed over recent requests') + '">';
  out += '<line class="perf-base" x1="0" y1="' + perfCoord(h - pad) + '" x2="' + w + '" y2="' + perfCoord(h - pad) + '"/>';
  // Ticks first, so the line and points draw over them.
  for (let i = 1; i < xs.length; i++) {
    if (xs[i].modelId === xs[i - 1].modelId) continue;
    const x = perfCoord(xAt(i));
    const name = typeof xs[i].modelId === 'string' && xs[i].modelId ? xs[i].modelId : 'an unnamed model';
    out += '<g class="perf-tick"><line x1="' + x + '" y1="0" x2="' + x + '" y2="' + h + '"/><title>Model changed to ' + perfEsc(name) + '</title></g>';
  }
  let run = [];
  const flush = () => {
    if (run.length > 1) out += '<polyline class="perf-line" fill="none" points="' + run.join(' ') + '"/>';
    run = [];
  };
  vals.forEach((v, i) => {
    if (v === null) { flush(); return; }
    run.push(perfCoord(xAt(i)) + ',' + perfCoord(yAt(v)));
  });
  flush();
  vals.forEach((v, i) => {
    if (v === null) return;
    const c = perfNum(xs[i].concurrent);
    const who = c === null ? '' : ' · ' + c + (c === 1 ? ' request' : ' requests') + ' at once';
    out += '<circle class="perf-pt" cx="' + perfCoord(xAt(i)) + '" cy="' + perfCoord(yAt(v)) + '" r="2.5"><title>'
      + perfEsc(perfClock(xs[i].at) + ' · ' + unit(v) + who) + '</title></circle>';
  });
  if (top > 0) out += '<text class="perf-axis" x="' + pad + '" y="' + (pad + 8) + '">' + perfEsc(unit(top)) + '</text>';
  return out + '</svg>';
}

/** "just now", "40 s ago", "3 min ago" — coarse, so a repaint every poll rarely changes it. */
function perfAgo(at, nowMs) {
  const a = perfNum(at), n = perfNum(nowMs);
  if (a === null || n === null) return '';
  const s = Math.max(0, Math.round((n - a) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return Math.floor(s / 10) * 10 + ' s ago';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  return 'at ' + perfClock(a);
}

function perfRowHTML(label, value, note) {
  return '<div class="tk-setrow set-diagrow perf-row"><div class="t">' + perfEsc(label) + '</div>'
    + '<div class="set-diagv perf-v">' + perfEsc(value) + (note ? '<span class="perf-avg">' + perfEsc(note) + '</span>' : '') + '</div></div>';
}

function perfAvg(mean, fmt) { return mean === null ? '' : 'average ' + fmt(mean); }

/** The rows and charts for one answer of the route. */
function perfBodyHTML(data, nowMs) {
  const xs = perfSamples(data.samples);
  const slots = data.slots && typeof data.slots === 'object' ? data.slots : null;
  const sum = perfSummary(xs, slots);
  const total = slots ? perfNum(slots.total) : null;
  const busy = slots ? perfNum(slots.busy) : null;
  const most = sum.concurrent.max;
  let workers;
  if (total !== null && busy !== null) {
    workers = perfInt(busy) + ' / ' + perfInt(total) + ' busy now' + (most !== null ? ' · most at once in recent requests: ' + perfInt(most) : '');
  } else {
    workers = most !== null ? 'Most at once in recent requests: ' + perfInt(most) : '—';
  }
  let out = '<div class="tk-list set-setlist set-diaglist perf-list">'
    + perfRowHTML('Generation', perfFormatRate(sum.generation.last), perfAvg(sum.generation.mean, perfFormatRate))
    + perfRowHTML('Prompt', perfFormatRate(sum.prompt.last), perfAvg(sum.prompt.mean, perfFormatRate))
    + perfRowHTML('Time to first token', perfFormatMs(sum.ttft.last), perfAvg(sum.ttft.mean, perfFormatMs))
    + perfRowHTML('Workers sharing the GPU', workers)
    + perfRowHTML('Context', perfFormatContext(sum.context.lastTokens, sum.context.perSlot))
    + '</div>';
  if (!xs.length) return out;
  const newest = xs[xs.length - 1];
  const model = typeof newest.modelId === 'string' && newest.modelId ? newest.modelId : '';
  const cap = perfNum(data.capacity);
  const ago = perfAgo(newest.at, nowMs);
  out += '<p class="set-cap perf-cap">'
    + perfEsc((model ? model + ' · ' : '') + 'last ' + xs.length + (xs.length === 1 ? ' request' : ' requests')
      + (cap !== null ? ' (keeps up to ' + perfInt(cap) + ')' : '') + (ago ? ' · newest ' + ago : ''))
    + '</p>';
  out += '<div class="perf-charts">'
    + '<figure class="perf-fig"><figcaption>Generation speed</figcaption>' + perfChartSVG(xs, 'generationPerSecond', PERF_CHART) + '</figure>'
    + '<figure class="perf-fig"><figcaption>Prompt speed</figcaption>' + perfChartSVG(xs, 'promptPerSecond', PERF_CHART) + '</figure>'
    + '</div>';
  return out;
}

function perfNoteHTML(text, tone) {
  return '<p class="perf-note' + (tone ? ' perf-note--' + tone : '') + '" role="status">' + perfEsc(text) + '</p>';
}

/**
 * The pane. `state` = {phase: 'loading'|'ok'|'unsupported'|'unreachable',
 * data, error}; `data` is the last good answer, kept across an unreachable
 * spell so the numbers stay on screen under the sentence.
 */
function perfPaneHTML(state, nowMs) {
  const st = state || {phase: 'loading', data: null};
  const data = st.data && typeof st.data === 'object' ? st.data : null;
  let out = '<div class="set-pane set-perf">'
    + '<p class="set-desc">How fast the local model answers, over its recent requests. Change the model, its quantization, the context size or the number of workers and watch the charts.</p>';
  if (st.phase === 'unsupported') {
    return out + perfNoteHTML('This agent is older than the performance view. Update the agent to see it.', 'warn') + '</div>';
  }
  if (st.phase === 'loading' && !data) return out + perfNoteHTML("Reading the local model's numbers…") + '</div>';
  if (st.phase === 'unreachable') {
    out += perfNoteHTML('The agent is not answering right now. The numbers come back when it does.', 'warn');
    return out + (data ? perfBodyHTML(data, nowMs) : '') + '</div>';
  }
  if (!data) return out + '</div>';
  const xs = perfSamples(data.samples);
  if (data.local !== true) {
    out += perfNoteHTML('The chat is on a cloud model. These numbers are for the local model server.');
    return out + (xs.length ? perfBodyHTML(data, nowMs) : '') + '</div>';
  }
  if (!xs.length) out += perfNoteHTML('No local requests yet. Send a message and the numbers appear here.');
  return out + perfBodyHTML(data, nowMs) + '</div>';
}

/**
 * The poll, as a small controller with its clock and request handed in (the
 * renderer passes the window's timers and BR.localPerformance; the tests a
 * fake clock). `onChange(state)` runs after an answer changed the state.
 *
 *   enter()          the pane came on screen: a new generation, ask now, then every 2 s
 *   leave()          it went away: a new generation, the timer cleared
 *   agentRestarted() a new agent process: a new generation, ask it now
 *   tick()           one poll: skipped while a request is out or the poll stopped
 */
function perfPoller(o) {
  const ctl = {
    state: {phase: 'loading', data: null, error: null},
    gen: 0,
    busy: false,
    /** A tick that found a request already out: ask again once it settles. */
    owed: false,
    active: false,
    timer: null,
    enter() {
      ctl.gen++;
      ctl.active = true;
      ctl.state = {phase: 'loading', data: ctl.state.data, error: null};
      ctl.startTimer();
      ctl.tick();
    },
    leave() {
      ctl.gen++;
      ctl.owed = false;
      ctl.active = false;
      ctl.stopTimer();
    },
    agentRestarted() {
      ctl.gen++;
      if (!ctl.active) return;
      // A new agent may be a newer one: an unsupported pane asks again.
      if (ctl.state.phase === 'unsupported') ctl.state = {phase: 'loading', data: null, error: null};
      ctl.startTimer();
      ctl.tick();
    },
    startTimer() {
      if (ctl.timer === null) ctl.timer = o.setInterval(() => ctl.tick(), o.intervalMs || PERF_POLL_MS);
    },
    stopTimer() {
      if (ctl.timer !== null) { o.clearInterval(ctl.timer); ctl.timer = null; }
    },
    tick() {
      if (!ctl.active) return;
      if (o.isVisible && !o.isVisible()) { ctl.leave(); return; }
      if (ctl.state.phase === 'unsupported') return;
      // One request out at a time, across enters, leaves and restarts too:
      // a newer generation waits for the older request to settle, then asks.
      if (ctl.busy) { ctl.owed = true; return; }
      ctl.owed = false;
      const gen = ctl.gen;
      ctl.busy = true;
      let p;
      try { p = Promise.resolve(o.request()); } catch (err) { p = Promise.reject(err); }
      p.then((res) => ctl.answer(gen, res), (err) => ctl.answer(gen, {ok: false, kind: 'unreachable', error: String((err && err.message) || err)}));
    },
    answer(gen, res) {
      ctl.busy = false; // whichever generation asked, its request is settled
      if (gen !== ctl.gen) {
        // An older enter, leave or agent: not this pane's answer. If the
        // current generation was kept waiting behind it, ask for it now.
        if (ctl.active && ctl.owed) ctl.tick();
        return;
      }
      if (o.isVisible && !o.isVisible()) { ctl.leave(); return; }
      if (res && res.ok === true && res.data && typeof res.data === 'object') {
        ctl.state = {phase: 'ok', data: res.data, error: null};
      } else if (res && res.kind === 'unsupported') {
        ctl.state = {phase: 'unsupported', data: null, error: null};
        ctl.stopTimer();
      } else {
        ctl.state = {phase: 'unreachable', data: ctl.state.data, error: String((res && res.error) || 'no answer')};
      }
      if (o.onChange) o.onChange(ctl.state);
    },
  };
  return ctl;
}

/* ---------------- the browser half ---------------- */

/** True while Settings › Performance is the pane on screen. */
function perfVisible() {
  return typeof S !== 'undefined' && !!S.settings && typeof settingsPaneId === 'function' && settingsPaneId(S.settingsPane) === 'performance';
}

let PERF = null;
let PERF_PAINTED = '';

function perfCtl() {
  if (!PERF) {
    PERF = perfPoller({
      request: () => (typeof BR !== 'undefined' && BR && typeof BR.localPerformance === 'function'
        ? BR.localPerformance()
        : Promise.resolve({ok: false, kind: 'unreachable', error: 'agent bridge not ready'})),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (t) => clearInterval(t),
      isVisible: perfVisible,
      onChange: perfRepaint,
    });
  }
  return PERF;
}

/** Settings' pane body for Performance. */
function perfPane() {
  PERF_PAINTED = perfPaneHTML(perfCtl().state, Date.now());
  return PERF_PAINTED;
}

/** After an answer: repaint the pane alone, and only when it reads differently. */
function perfRepaint() {
  if (!perfVisible()) return;
  const html = perfPaneHTML(perfCtl().state, Date.now());
  if (html === PERF_PAINTED) return;
  PERF_PAINTED = html;
  if (typeof paneRepaintKeepFocus === 'function') paneRepaintKeepFocus(html);
  else if (typeof render === 'function') render();
}

/** Called at the top of every render: the poll follows the pane on and off screen. */
function perfFollow() {
  const ctl = perfCtl();
  const on = perfVisible();
  if (on && !ctl.active) ctl.enter();
  else if (!on && ctl.active) ctl.leave();
}

/** A new agent process came up: an answer from the old one is stale. */
function perfAgentRestarted() {
  if (PERF) PERF.agentRestarted();
}

if (typeof module !== 'undefined') {
  module.exports = {
    PERF_POLL_MS, perfEsc, perfSummary, perfFormatRate, perfFormatMs, perfFormatContext,
    perfChartSVG, perfPaneHTML, perfPoller,
  };
}
