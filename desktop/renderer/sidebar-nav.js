/* ATO-457 / ATO-538: the sidebar's section rows, the collapsed rail's row
 * glyphs and the narrow-window drawer, as pure functions (no DOM, no renderer
 * state) so they can be unit-tested (test/sidebar-nav.test.mjs).
 *
 * ATO-457 (U-24, owner's decision B): Tasks and Skills are standing rows under
 * New chat, so the places ⌘ 2 and ⌘ 3 lead to have a home in the sidebar. Both
 * still open their Settings tab (renderer.js act('room:…')); the row is lit
 * while that tab is the one on screen.
 *
 * ATO-538 (U-106): in the 52px rail every chat used to be the same dot. A row
 * now carries a glyph (the first letter, digit or emoji of its title) that the
 * rail paints in a small disc, with the status dot as a badge on it; the full
 * name stays in the row's tooltip. And below 1000px, where the rail is forced
 * by the window width, the sidebar toggle (and ⌘ 0) opens the full sidebar as a
 * drawer over the content instead of refusing. */

/** The standing section rows, top to bottom. `pane` is the open Settings tab
    (null while Settings is closed). */
function sidebarNavItems(pane) {
  return [
    {id: 'tasks', label: 'Tasks', icon: 'tasks', act: 'room:tasks', chord: '⌘ 2', on: pane === 'tasks'},
    {id: 'skills', label: 'Skills', icon: 'skills', act: 'room:skills', chord: '⌘ 3', on: pane === 'skills'},
  ];
}

/* The first letter, digit or pictograph of a title, upper-cased, so rail rows
   differ at a glance. Leading punctuation and spaces are skipped ("#2 bug" is
   "2", "'quoted'" is "Q"). An emoji keeps its whole grapheme (a flag, a
   skin-tone or ZWJ sequence), where the runtime can segment one. A title with
   none of these gets no glyph: the row draws its dot alone, as before. */
const RAIL_GLYPH_RE = /[\p{L}\p{N}\p{Extended_Pictographic}\p{Regional_Indicator}]/u;
function railGlyph(title) {
  const s = String(title == null ? '' : title);
  const parts = typeof Intl !== 'undefined' && Intl.Segmenter
    ? Array.from(new Intl.Segmenter(undefined, {granularity: 'grapheme'}).segment(s), (x) => x.segment)
    : Array.from(s);
  for (const g of parts) {
    if (!RAIL_GLYPH_RE.test(g)) continue;
    return /[\p{L}]/u.test(g) ? g.toLocaleUpperCase() : g;
  }
  return '';
}

/* What the sidebar toggle (button and ⌘ 0) does. On a wide window it flips
   the collapse the operator keeps (`sidebar`: 'open' | 'rail'). On a narrow
   one the width already forces the rail, so it opens or closes the drawer and
   leaves the kept collapse alone. A wide window never holds a drawer. */
function toggleSidebar(st) {
  const s = st || {};
  if (s.narrow) return {sidebar: s.sidebar, drawer: !s.drawer};
  return {sidebar: s.sidebar === 'rail' ? 'open' : 'rail', drawer: false};
}

/** The toggle's look: lit and pressed while the full sidebar is on screen
    (expanded on a wide window, the drawer on a narrow one). */
function sidebarToggleView(st) {
  const s = st || {};
  const open = s.narrow ? !!s.drawer : s.sidebar !== 'rail';
  return {open, label: open ? 'Hide sidebar (⌘ 0)' : 'Show sidebar (⌘ 0)'};
}

if (typeof module !== 'undefined') module.exports = {sidebarNavItems, railGlyph, toggleSidebar, sidebarToggleView};
