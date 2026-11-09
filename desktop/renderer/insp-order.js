/* ---------------- ATO-1249: the side panel's Steps and Reasoning, newest first ----------------
   Loaded before renderer.js. The side panel (inspector) listed a chat's steps
   and reasoning oldest first, so on a long turn the step running now was at
   the bottom of a long list. Now the newest is on top, as people asked; a
   small switch above the list ("Newest first" / "Oldest first") turns it
   back, and the choice is kept per viewer like the theme.

   The scroll follows the order: with the newest on top, a panel at the top
   stays at the top as steps arrive, and one scrolled down keeps the step it
   shows in place while new ones come in above. Oldest first keeps the old
   behaviour (the end follows new text).

   The pure part is exported for test/insp-order.test.mjs. */

/* Per viewer, a display preference, nothing the agent reads. */
const INSP_ORDER_KEY = 'atag.inspNewestFirst';
const INSP_ORDER = {newestFirst: (() => {
  try { return typeof localStorage === 'undefined' || localStorage.getItem(INSP_ORDER_KEY) !== '0'; } catch (e) { return true; }
})()};

function inspOrderSet(newestFirst) {
  INSP_ORDER.newestFirst = !!newestFirst;
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(INSP_ORDER_KEY, newestFirst ? '1' : '0'); } catch (e) { /* no storage: the choice lasts this launch */ }
}

/** The list as the panel shows it; the caller numbers the rows before, so a step keeps its number. */
function inspOrdered(list) {
  const rows = Array.isArray(list) ? list : [];
  return INSP_ORDER.newestFirst ? rows.slice().reverse() : rows;
}

/** The switch above a list of two or more. deps: {esc}. */
function inspOrderHTML(count, deps) {
  if (!(count >= 2)) return '';
  const {esc} = deps;
  const now = INSP_ORDER.newestFirst ? 'Newest first' : 'Oldest first';
  const next = INSP_ORDER.newestFirst ? 'Show the oldest first' : 'Show the newest first';
  return '<div class="insp-order"><button class="insp-orderbtn" data-act="inspord:toggle" title="' + esc(next) + '"'
    + ' aria-label="' + esc(now + '. ' + next) + '">' + esc(now) + '</button></div>';
}

/**
 * Where the rebuilt list should be scrolled, from the old one ({scrollTop,
 * scrollHeight, clientHeight}): the place that follows new rows stays there
 * (the top when newest first, the end when oldest first); anywhere else, the
 * rows on screen stay (newest first: the same distance from the end, since
 * new rows come in above).
 */
function inspScrollKeep(prev, newestFirst) {
  if (!prev) return null;
  if (newestFirst) return prev.scrollTop < 4 ? {at: 'start'} : {fromEnd: prev.scrollHeight - prev.scrollTop};
  return prev.scrollHeight - prev.scrollTop - prev.clientHeight < 4 ? {at: 'end'} : {top: prev.scrollTop};
}

/** The scrollTop for the rebuilt list ({scrollHeight}) under `keep`. */
function inspScrollTo(keep, now) {
  if (!keep || !now) return 0;
  if (keep.at === 'start') return 0;
  if (keep.at === 'end') return now.scrollHeight;
  if (typeof keep.fromEnd === 'number') return Math.max(0, now.scrollHeight - keep.fromEnd);
  return Math.max(0, keep.top || 0);
}

/**
 * Newest first, where the panel goes when the running block's text grew by
 * `grown` px; null leaves it alone. `prev` is the panel before the growth, and
 * `wellAbove` says the end of that block was above the panel's top edge. New
 * text lands at the end of the block, not above it: what a reader sees inside
 * the block does not move, so only rows below the new text, or a reader at the
 * very end, need the scroll to move with it. The top stays the top.
 */
function inspGrowScroll(prev, grown, wellAbove) {
  if (!prev || prev.scrollTop < 4) return null;
  const atEnd = prev.scrollHeight - prev.scrollTop - prev.clientHeight < 4;
  return atEnd || wellAbove ? prev.scrollTop + grown : null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {INSP_ORDER_KEY, INSP_ORDER, inspOrderSet, inspOrdered, inspOrderHTML, inspScrollKeep, inspScrollTo, inspGrowScroll};
}
