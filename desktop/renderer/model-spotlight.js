/* ---------------- A launch's model, one click from running it ----------------
   Loaded before renderer.js; declares only. Shared by the renderer and the
   Node checks (test/model-spotlight.test.mjs).

   A catalogue row marked `spotlight` (main/model-catalog.ts, set on launch day)
   puts a "New: <name>" card on the chat. This is which row it offers, if any.
   Nothing marked: nothing offered. */

/* The row to offer, or null.
   `models`: the `models list` rows, with `downloaded` and the catalogue fields.
   `ramGb`: this machine's memory. `dismissed`: the ids closed on the card.
   `fitFor`: the renderer's verdict (renderer.js fitFor), the same "Fits well"
   as Settings. `diskFit`: the renderer's check of one row (modelDiskFit).
   `unfinished`: the id whose card was pressed and whose model never started
   (a quit, a Cancel or a failure after the weights landed), or null.

   One of a launch's rows already on disk means this machine has the launch:
   none. Uncensored rows are never offered. Of the rest, the largest that runs
   comfortably here, the first in list order on a tie. When that one has no
   room on the disk nothing is offered, rather than a smaller model than the
   machine deserves. The unfinished row is the exception to the first rule:
   being on disk is how it got stranded, so it alone is offered again. */
function modelSpotlightPick(input) {
  const {models, ramGb, dismissed, fitFor, diskFit, unfinished} = input || {};
  let marked = (Array.isArray(models) ? models : []).filter((m) => m && m.id && m.spotlight === true);
  if (marked.some((m) => m.downloaded && m.id !== unfinished)) return null;
  if (marked.some((m) => m.downloaded)) marked = marked.filter((m) => m.id === unfinished);
  if (!marked.length) return null;
  if (!(Number(ramGb) > 0) || typeof fitFor !== 'function') return null;
  const closed = new Set(Array.isArray(dismissed) ? dismissed : []);
  let best = null;
  for (const m of marked) {
    if (m.uncensored || closed.has(m.id)) continue;
    // fitFor estimates a row with no figures from its file size: a launch row without them is not offered.
    const wants = Number(m.recommendedRamGb) || 0;
    if (!wants || fitFor(m, ramGb).v !== 'comfortable') continue;
    if (!best || wants > Number(best.recommendedRamGb)) best = m;
  }
  if (!best) return null;
  const disk = typeof diskFit === 'function' ? diskFit(best) : null;
  return disk && disk.ok === false ? null : best;
}

/* The stored list of dismissed ids; anything else in storage reads as none. */
function modelSpotlightParseDismissed(raw) {
  try {
    const list = JSON.parse(String(raw));
    return Array.isArray(list) ? list.filter((id) => typeof id === 'string' && id) : [];
  } catch (e) { return []; }
}

if (typeof module !== 'undefined') module.exports = {modelSpotlightPick, modelSpotlightParseDismissed};
