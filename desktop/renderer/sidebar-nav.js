/* ATO-457 / ATO-538: the sidebar's section rows, the collapsed rail's row
 * glyphs and the narrow-window drawer, as pure functions (no DOM, no renderer
 * state) so they can be unit-tested (test/sidebar-nav.test.mjs).
 *
 * ATO-457 (U-24, owner's decision B): Tasks (now "Cron jobs") and Skills are
 * standing rows under New chat, so the places ⌘ 2 and ⌘ 3 lead to have a home in the sidebar. Both
 * still open their Settings tab (renderer.js act('room:…')); the row is lit
 * while that tab is the one on screen.
 *
 * ATO-538 (U-106): in the 52px rail every chat used to be the same dot. A row
 * now carries a glyph (the first letter, digit or emoji of its title) that the
 * rail paints in a small disc, with the status dot as a badge on it; the full
 * name stays in the row's tooltip. And below 1000px, where the rail is forced
 * by the window width, the sidebar toggle (and ⌘ \) opens the full sidebar as a
 * drawer over the content instead of refusing. */

/** The standing section rows under the Studio row, top to bottom. `pane` is
    the open Settings tab (null while Settings is closed).

    W2 (sidebar like Claude desktop): the Tasks row is labelled "Cron jobs"
    (ids, verbs and ⌘ 2 are unchanged), Skills stays, and a Plugins row opens
    Settings › Plugins. "New project" left these rows: it is the small button
    on the Projects header now (chat-projects.js). A second argument
    (the old `{projects}` option) is ignored. */
function sidebarNavItems(pane) {
  return [
    {id: 'tasks', label: 'Cron jobs', icon: 'timer', act: 'room:tasks', chord: '⌘ 2', on: pane === 'tasks'},
    {id: 'skills', label: 'Skills', icon: 'bookOpen', act: 'room:skills', chord: '⌘ 3', on: pane === 'skills'},
    {id: 'plugins', label: 'Plugins', icon: 'puzzle', act: 'settings:plugins', chord: '', on: pane === 'plugins'},
  ];
}

/* W2: the sidebar's top rows draw Lucide glyphs (24px grid, 1.5 stroke) at
   16px, so New chat, Studio, Cron jobs, Skills, Plugins and the Projects
   button read as one thin set. Lucide is ISC licensed. */
const LUCIDE = {
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  sparkles: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>',
  timer: '<line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/>',
  bookOpen: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
  puzzle: '<path d="M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  video: '<path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
  folderPlus: '<path d="M12 10v6"/><path d="M9 13h6"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
};
/** A Lucide glyph as a 16px inline SVG; '' for a name not in the set. */
function lucideIcon(name) {
  const body = LUCIDE[name];
  if (!body) return '';
  return '<svg class="lucide" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" '
    + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
}

/* W2: the Studio row's popover, Image then Video, from the pages Studio has
   registered (studio/shell.js). Each item opens its existing page. */
function studioMenuItems(kinds) {
  const words = {images: ['Image', 'image'], video: ['Video', 'video']};
  return (kinds || []).map((k) => ({kind: k, label: words[k] ? words[k][0] : String(k), icon: words[k] ? words[k][1] : 'sparkles', act: 'studio:open:' + k}));
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

/* What the sidebar toggle (button and ⌘ \) does. On a wide window it flips
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
  return {open, label: open ? 'Hide sidebar (⌘ \\)' : 'Show sidebar (⌘ \\)'};
}

if (typeof module !== 'undefined') module.exports = {sidebarNavItems, railGlyph, toggleSidebar, sidebarToggleView, lucideIcon, studioMenuItems, LUCIDE};
