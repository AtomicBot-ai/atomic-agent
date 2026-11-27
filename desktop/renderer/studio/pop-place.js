/* Studio: where a picker opens beside its field, and how tall it may be
   (ATO-2415). The Images model list used to sit on the field's bottom edge
   and grow upwards with the whole column's height as its cap, so a field in
   the middle of the column let the list run past the top of the window.

   Pure geometry: client rects in, offsets out. No DOM. Loaded before the
   pages; tested alone in test/studio-pop-place.test.mjs. Every name starts
   with `studioPop` so it cannot meet one of renderer.js's globals.

   Precedent: Floating UI's `flip` + `size` middleware (used by Radix and
   shadcn popovers) and macOS NSMenu: keep the preferred side while the
   list fits there, otherwise the other side if it fits, otherwise the
   side with more room, and never taller than that room. */

const STUDIO_POP_PAD = 8;

/**
 * @param field {top, bottom}: the field's client rect.
 * @param box {top, bottom}: the containing block the popover is positioned in (the popwrap).
 * @param want the popover's natural height (its scrollHeight), or 0 when unknown.
 * @param pad the gap kept from the clip's top and bottom edges.
 * @param clip {top, bottom}: the area the popover must stay inside; the box itself when
 *   omitted. Differs from the box when the column scrolls (the narrow layout).
 * @returns {{side: 'up'|'down', top: number|null, bottom: number|null, maxHeight: number}}
 *   `bottom`/`top` are px offsets from the box's edge for the side that is set; the other is null.
 */
function studioPopPlace(field, box, want, pad, clip) {
  pad = pad == null ? STUDIO_POP_PAD : pad;
  clip = clip || box;
  const lo = clip.top + pad, hi = clip.bottom - pad;
  const clamp = (y) => Math.min(hi, Math.max(lo, y));
  // Up: the list's bottom edge on the field's bottom edge, growing towards the top (how it has always opened).
  const bottomY = clamp(field.bottom);
  const roomUp = Math.max(0, Math.round(bottomY - lo));
  // Down: the list's top edge on the field's top edge, growing towards the bottom.
  const topY = clamp(field.top);
  const roomDown = Math.max(0, Math.round(hi - topY));
  const need = Math.max(0, Math.round(want || 0));
  const up = need && need <= roomUp ? true : need && need <= roomDown ? false : roomUp >= roomDown;
  return up
    ? {side: 'up', top: null, bottom: Math.round(box.bottom - bottomY), maxHeight: roomUp}
    : {side: 'down', top: Math.round(topY - box.top), bottom: null, maxHeight: roomDown};
}

/** Writes a placement onto the popover's inline style; the unused side is released. */
function studioPopApply(style, place) {
  style.top = place.side === 'down' ? place.top + 'px' : 'auto';
  style.bottom = place.side === 'up' ? place.bottom + 'px' : 'auto';
  style.maxHeight = place.maxHeight + 'px';
}

if (typeof module !== 'undefined') {
  module.exports = {STUDIO_POP_PAD, studioPopPlace, studioPopApply};
}
