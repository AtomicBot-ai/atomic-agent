/* ATO-1503 — Pause / Resume on a model download row (the download card,
   renderDlcard).

   LM Studio's and Ollama's download lists: a running model download has a
   Pause beside its Cancel; a paused one keeps its bar where it stopped, says
   "Paused", and has Resume. Main does the work (main/download-pause.ts): pause
   stops `atag models pull` and keeps its partial file, resume runs the same
   pull, which the agent continues from the partial (HTTP Range), and Cancel
   deletes the partial, as the agent's `models downloads pause|resume|cancel`.

   Main tells which download can pause on `cli:pullPaused`
   ({id, pausable, paused, pausing}). Only the weights download in main's one
   slot can: not the llama.cpp runtime, an embedding model, or a Hugging Face
   model's projector (fetched by main itself, `src:'proj'`).

   renderer.js calls dlPauseMark (dlCardRows), dlPauseBtnHTML (dlCardRowHTML),
   dlPausedLine (dlCardLine) and dlPauseAct (dlCardAct). */

const DLP = {id: null, pausable: false, paused: false, pausing: false, busy: false};

/** Take main's frame. True when what the card says changed. */
function dlPauseApply(frame) {
  const f = frame && typeof frame === 'object' ? frame : {};
  const next = {
    id: typeof f.id === 'string' ? f.id : null,
    pausable: f.pausable === true,
    paused: f.paused === true,
    pausing: f.pausing === true,
  };
  const changed = next.id !== DLP.id || next.pausable !== DLP.pausable
    || next.paused !== DLP.paused || next.pausing !== DLP.pausing || DLP.busy;
  Object.assign(DLP, next, {busy: false});
  return changed;
}

/** This row is main's pausable download. */
function dlPauseOwns(r) {
  return !!(r && DLP.pausable && DLP.id && r.id === DLP.id && r.src !== 'proj'
    && r.kind !== 'runtime' && r.kind !== 'embedding');
}

/** dlCardRows' last step: a paused (or pausing) download says so. */
function dlPauseMark(rows) {
  (rows || []).forEach((r) => {
    if (!dlPauseOwns(r) || (r.state !== 'active' && r.state !== 'starting')) return;
    if (DLP.paused) r.state = 'paused';
    else if (DLP.pausing) r.state = 'pausing';
  });
  return rows;
}

/** The Pause or Resume button before the row's ×; nothing for a row that cannot pause. */
function dlPauseBtnHTML(r, name, icon, escape) {
  if (!dlPauseOwns(r)) return '';
  const esc = typeof escape === 'function' ? escape : String;
  const ic = typeof icon === 'function' ? icon : () => '';
  const off = DLP.busy ? ' disabled' : '';
  if (r.state === 'paused') {
    return '<button class="iconbtn sm dlc-resume" data-act="dlc:resume" aria-label="Resume the download of ' + esc(name) + '"'
      + ' title="Resume download"' + off + '>' + ic('play') + '</button>';
  }
  if (r.state !== 'active') return '';
  return '<button class="iconbtn sm dlc-pause" data-act="dlc:pause" aria-label="Pause the download of ' + esc(name) + '"'
    + ' title="Pause download"' + off + '>' + ic('pause') + '</button>';
}

/** The line under a paused row's bar: "Paused · 2.5 of 6.2 GB · 40%". */
function dlPausedLine(r, percent, bytesPair) {
  if (r.state === 'pausing') return 'Pausing…';
  const t = r.track || {};
  const parts = ['Paused'];
  if (t.totalBytes > 0 && typeof bytesPair === 'function') parts.push(bytesPair(t.transferredBytes || 0, t.totalBytes));
  parts.push((percent || 0) + '%');
  return parts.join(' · ');
}

/** The card's `dlc:pause` / `dlc:resume`. ATO-2745: a refusal says so in a short toast
    (`notify(title, line, kind)`, renderer.js toast by default) instead of only freeing the button. */
function dlPauseAct(verb, br, repaint, notify) {
  if (!br || DLP.busy || !DLP.id) return false;
  const call = verb === 'pause' ? br.pausePull : verb === 'resume' ? br.resumePull : null;
  if (typeof call !== 'function') return false;
  const say = typeof notify === 'function' ? notify : (typeof toast === 'function' ? toast : null);
  DLP.busy = true;
  if (typeof repaint === 'function') repaint();
  Promise.resolve(call(DLP.id)).catch(() => null).then((res) => {
    // Main's frame follows a pause or resume that took; a refusal frees the button and says so.
    if (!res || res.ok !== true) {
      DLP.busy = false;
      if (typeof repaint === 'function') repaint();
      if (say) say(verb === 'pause' ? 'Could not pause the download' : 'Could not resume the download', 'Try again in a moment.', 'bad');
    }
  });
  return true;
}

/** Follow main's frames, and ask once: a reopened window may land on a paused download. */
function dlPauseInit(br, repaint) {
  if (!br || typeof br.onPullPaused !== 'function') return;
  const take = (f) => { if (dlPauseApply(f) && typeof repaint === 'function') repaint(); };
  br.onPullPaused(take);
  if (typeof br.pullPauseState === 'function') Promise.resolve(br.pullPauseState()).then(take, () => {});
}

if (typeof module !== 'undefined') {
  module.exports = {DLP, dlPauseApply, dlPauseOwns, dlPauseMark, dlPauseBtnHTML, dlPausedLine, dlPauseAct, dlPauseInit};
}
