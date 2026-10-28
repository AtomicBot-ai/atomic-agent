/* ---------------- ATO-1257: a failure the agent got past is quiet ----------------
   Loaded before renderer.js; declares only. Shared with the Node checks
   (test/tool-failures.test.mjs).

   «закрой хром»: five red cards "Couldn't run commands", each with its error
   text, stacked up in a turn that then closed Chrome and said so. A failed
   call the agent went on from is part of how it worked, not news. So:
   - quiet: a failed call in a turn that is still running, or one followed by
     a call that worked later in the same turn. Its card has no red wash and
     no red text; the alert, "Couldn't …" and the error line stay, in the
     muted ink. Two or more quiet failures in a row are one line, "3 attempts
     failed", that opens in place on a click (each card unchanged inside).
   - loud (red, as before): a failure nothing worked after in a finished turn,
     the one that ended it; and a failure that needs the person (a key to
     enter, a permission to grant), wherever it is. */

/** Does this failure ask something of the person? A key card under it, or a permission or sign-in. */
function toolFailNeedsPerson(m) {
  if (!m) return false;
  if (m.keyReq) return true;
  return /\b(permission|System Settings|Privacy & Security|Screen Recording|Accessibility|sign in|log in|API key)\b/i.test(String(m.out || ''));
}

/**
 * The ids of the failed tool cards drawn quietly.
 * opts.running: the last turn of `log` is still running.
 * opts.failed(m): the card shows a failure (renderer.js: toolState === 'err').
 * opts.worked(m): the card shows a call that worked (renderer.js: toolState === 'ok').
 */
function quietToolFailures(log, opts) {
  const o = opts || {};
  const failed = typeof o.failed === 'function' ? o.failed : (m) => m.ok === false && m.outcome == null;
  const worked = typeof o.worked === 'function' ? o.worked : (m) => m.ok === true;
  const quiet = new Set();
  if (!Array.isArray(log)) return quiet;
  // A turn runs from a message that is not a steer to the next one.
  const starts = [];
  log.forEach((m, i) => { if (m && m.k === 'user' && !m.steered) starts.push(i); });
  if (!starts.length || starts[0] !== 0) starts.unshift(0);
  for (let t = 0; t < starts.length; t++) {
    const from = starts[t], to = t + 1 < starts.length ? starts[t + 1] : log.length;
    const running = !!o.running && t === starts.length - 1;
    let workedAfter = false;
    for (let i = to - 1; i >= from; i--) {
      const m = log[i];
      if (!m || m.k !== 'tool') continue;
      if (failed(m)) {
        if ((workedAfter || running) && !toolFailNeedsPerson(m)) quiet.add(m.id);
      } else if (worked(m)) workedAfter = true;
    }
  }
  return quiet;
}

/** "3 attempts failed": the line a run of quiet failures folds into. deps: {esc, ic}. */
function failRunHTML(run, deps) {
  const {esc, ic} = deps;
  const first = run[0];
  return '<div class="turn tk-step" id="failrun-' + esc(first.id) + '"><div></div><div><div class="card soft" data-tool="' + esc(first.name) + '">'
    + '<button class="cardhead" data-failrun="' + esc(first.id) + '" aria-expanded="false" title="Show the attempts">'
    + '<span class="tl-ic">' + ic('alert') + '</span>'
    + '<span class="nm">' + run.length + ' attempts failed</span>'
    + '<span class="tl-st soft" title="The agent went on after these">' + ic('alert') + '</span>'
    + '<span class="chev">' + ic('chevR') + '</span></button>'
    + '</div></div></div>';
}

if (typeof module !== 'undefined' && module.exports) module.exports = {quietToolFailures, toolFailNeedsPerson, failRunHTML};
