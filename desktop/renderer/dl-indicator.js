/* ATO-1185 (ATO-1032 item 4) — downloads live in the sidebar header.

   Jan's pattern: a small download icon with a count in .sb-head while
   anything is downloading, failed or waiting, and a click on it opens the
   download list (#dlcard, renderDlcard) as a popover under the header. The
   card no longer floats over the bottom-right corner, so it never covers the
   composer's picker or the toast column (ATO-1025 item 5).

   This file holds the two pure pieces: where the popover stands, and the key
   that says when the header icon must be redrawn. renderer.js draws both. */

/** The popover's width (CSS #dlcard uses the same number). */
const DLI_POP_W = 288;
/** A sidebar narrower than this is the icon rail (or the narrow window's). */
const DLI_RAIL_MAX = 120;

/**
 * Where the popover stands inside #window, in px from its top-left corner.
 * Rects are DOMRect-like ({top, bottom, left, right, width, height}).
 *
 * - Expanded sidebar: left-aligned with the header, just under it. It is
 *   only a little wider than the sidebar, so it stays in the column's gutter
 *   and never reaches the conversation, the composer or the toasts.
 * - Icon rail: beside the rail, level with the header.
 * - No sidebar on screen: the top-left corner under the toolbar.
 *
 * `room` is how tall the list may grow before it scrolls.
 */
function dlPopoverSpot(win, sidebar, head, toolbar, gap, edge) {
  const g = typeof gap === 'number' ? gap : 8;
  const e = typeof edge === 'number' ? edge : 16;
  let left, top;
  const sb = sidebar && sidebar.width > 0 && sidebar.height > 0 ? sidebar : null;
  const hd = head && head.width > 0 && head.height > 0 ? head : null;
  if (sb && hd && sb.width < DLI_RAIL_MAX) {
    left = sb.right - win.left + g;
    top = hd.top - win.top;
  } else if (hd) {
    left = hd.left - win.left;
    top = hd.bottom - win.top + g;
  } else {
    left = e;
    top = (toolbar ? toolbar.bottom - win.top : 0) + g;
  }
  // Never past the window's right edge in a very narrow window.
  const maxLeft = Math.max(e, win.width - DLI_POP_W - e);
  left = Math.max(0, Math.min(Math.round(left), Math.round(maxLeft)));
  top = Math.max(0, Math.round(top));
  const room = Math.max(120, Math.round(win.height - top - e));
  return {left, top, room};
}

/** What the header icon says: redrawn only when this changes, so a hover on it survives the samples. */
function dlIndicatorKey(n, failed, moving, open) {
  return n ? [n, failed ? 'f' : '', moving ? 'm' : '', open ? 'o' : 'c'].join('|') : '';
}

if (typeof module !== 'undefined') module.exports = {DLI_POP_W, DLI_RAIL_MAX, dlPopoverSpot, dlIndicatorKey};
