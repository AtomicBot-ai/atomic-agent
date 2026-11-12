/* ---------------- ATO-1150: search and archive in the chat list ----------------
   Loaded before renderer.js, after chat-list.js; declares only. The pure half
   (chatSearch, splitArchived, archiveSet) is chat-list.js, tested in
   test/chat-list.test.mjs; this is the renderer half, which reads renderer.js
   globals (PREFS, SESSIONS, PENDING_CHATS, chatRow, esc, ic, act, render,
   savePrefs, toast) at call time, as chat-folders.js does.

   Search: a field at the top of the chat lists filters the chats by title
   with the ⌘K palette's ranking (fuzzy-match.js). While it holds a query the
   lists show the matches only, archived ones under their own heading; Enter
   opens the best one, Escape clears the field. Titles only: the agent has no
   route to search the text of past chats yet (ATO-1013 item 1). The palette
   is unchanged.

   Archive: the row menu's Archive takes a stored chat out of Pinned, its
   folder's list and Chats, into an "Archived" section folded at the bottom of
   the chats; Unarchive (same menu) puts it back where it was. The list of
   archived ids lives in userData/prefs.json beside the pins (main.ts
   coercePrefs): the agent has no archive flag or route, so nothing is written
   to the session store and the terminal does not see it. Archiving unpins.

   The sidebar is rebuilt whole on every render, so the field's text lives in
   CHATSEARCH.q and its focus and caret are carried across the rebuild
   (chatSearchHold / chatSearchRestore around renderSidebar's write). */

const CHATSEARCH = {q: '', archOpen: false};

/** Whether the lists show search results: a query, and the sidebar not folded to the rail. */
function chatSearchOn() {
  if (!chatSearchQuery(CHATSEARCH.q)) return false;
  const sb = typeof document !== 'undefined' ? document.getElementById('sidebar') : null;
  return !(sb && sb.classList.contains('rail'));
}

function chatSearchFieldHTML() {
  const has = CHATSEARCH.q !== '';
  return '<div class="sb-search' + (has ? ' has-q' : '') + '" role="search">'
    + '<span class="sb-search-ic">' + ic('search') + '</span>'
    + '<input id="chat-search" type="text" placeholder="Search chats" aria-label="Search chats"'
      + ' autocomplete="off" spellcheck="false" value="' + esc(CHATSEARCH.q) + '">'
    + (has ? '<button class="iconbtn sb-search-x" data-act="chatsearch:clear" title="Clear search" aria-label="Clear search">' + ic('x') + '</button>' : '')
    + '</div>';
}

/** Every chat the search can find: the stored ones (archived too), then new chats still starting. */
function chatSearchRows() {
  const stored = new Set(SESSIONS.map((s) => s.id));
  return SESSIONS.concat([...PENDING_CHATS.values()].filter((p) => p && !stored.has(p.id)));
}

/** The lists' content while a query is typed: the matches, archived ones under their own heading. */
function chatSearchListsHTML() {
  const r = chatSearch(CHATSEARCH.q, chatSearchRows(), PREFS.archived);
  const more = r.total - r.live.length - r.archived.length;
  return '<div class="sb-list sb-results" data-list="results">'
      + '<div class="sb-list-head micro"><span>Results</span>'
        + (r.total ? '<span class="ct tnum">' + r.total + '</span>' : '') + '</div>'
      + (r.live.length ? r.live.map(chatRow).join('')
         : r.archived.length ? '' : '<div class="sb-empty">No chat titles match</div>')
    + '</div>'
    + (r.archived.length
      ? '<div class="sb-list sb-archived" data-list="archived-results">'
        + '<div class="sb-list-head micro"><span>Archived</span><span class="ct tnum">' + r.archived.length + '</span></div>'
        + r.archived.map(chatRow).join('')
      + '</div>'
      : '')
    + (more > 0 ? '<div class="sb-empty">' + more + ' more · type more of the title</div>' : '');
}

/** The folded "Archived" section under Chats; nothing while no chat is archived. */
function archivedSidebarHTML(rows) {
  if (!rows || !rows.length) return '';
  const open = CHATSEARCH.archOpen;
  return '<div class="sb-list sb-archived' + (open ? '' : ' collapsed') + '" data-list="archived">'
    + '<button class="sb-fhead sb-archhead" data-act="archtoggle:" aria-expanded="' + open + '"'
      + ' title="' + esc((open ? 'Hide' : 'Show') + ' archived chats') + '">'
      + '<span class="sb-fchev">' + ic(open ? 'chevD' : 'chevR') + '</span>'
      + '<span class="sb-fic">' + ic('archive') + '</span>'
      + '<span class="sb-fname">Archived</span>'
      + '<span class="ct tnum">' + rows.length + '</span>'
    + '</button>'
    + (open ? rows.map(chatRow).join('') : '')
    + '</div>';
}

/** Archive (`on`) or unarchive chat `id`; returns whether anything changed. */
function chatArchive(id, on) {
  if (!id || !SESSIONS.some((s) => s.id === id)) return false;
  const was = PREFS.archived.includes(id);
  if (was === !!on) return false;
  PREFS.archived = archiveSet(PREFS.archived, id, !!on);
  if (on) PREFS.pinned = PREFS.pinned.filter((x) => x !== id);   // an archived chat is not on the main list, Pinned included
  savePrefs();
  const s = SESSIONS.find((x) => x.id === id);
  toast(on ? 'Chat archived' : 'Chat unarchived', (s && s.t) || '');
  return true;
}

/* The act() verbs: archive:<id>, unarchive:<id>, archtoggle:, chatsearch:clear.
   Returns true when the verb was one of these. */
function chatArchiveAct(k, v, close) {
  if (k === 'archive' || k === 'unarchive') {
    close();
    chatArchive(v, k === 'archive');
    render(); nameVisibleSessions();
    return true;
  }
  if (k === 'archtoggle') { CHATSEARCH.archOpen = !CHATSEARCH.archOpen; render(); nameVisibleSessions(); return true; }
  if (k === 'chatsearch') {
    CHATSEARCH.q = '';
    renderSidebar();
    const f = document.getElementById('chat-search');
    if (f) f.focus({preventScroll: true});
    return true;
  }
  return false;
}

/** Before the sidebar's rebuild: the field's focus and caret, or null when it does not hold the focus. */
function chatSearchHold() {
  const a = typeof document !== 'undefined' ? document.activeElement : null;
  if (!a || a.id !== 'chat-search') return null;
  return {start: a.selectionStart, end: a.selectionEnd};
}
function chatSearchRestore(held) {
  if (!held) return;
  const f = document.getElementById('chat-search');
  if (!f || document.activeElement === f) return;
  f.focus({preventScroll: true});
  try { f.setSelectionRange(held.start, held.end); } catch (e) { /* the caret goes to the end */ }
}

if (typeof document !== 'undefined') {
  /* Typing repaints the sidebar only (not the whole window). Nothing repaints
     mid-composition (an IME): compositionend does, as ATO-822 does for the palette. */
  const onType = (e) => {
    if (!e.target || e.target.id !== 'chat-search' || e.isComposing) return;
    if (CHATSEARCH.q === e.target.value) return;
    CHATSEARCH.q = e.target.value;
    renderSidebar();
  };
  document.addEventListener('input', onType);
  document.addEventListener('compositionend', onType);
  // Capture phase, ahead of the window's own key handler: Enter and Escape in the field are the field's.
  document.addEventListener('keydown', (e) => {
    if (!e.target || e.target.id !== 'chat-search' || e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      if (CHATSEARCH.q) { CHATSEARCH.q = ''; renderSidebar(); }
      else e.target.blur();
      return;
    }
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault(); e.stopPropagation();
      const r = chatSearch(CHATSEARCH.q, chatSearchRows(), PREFS.archived);
      const first = r.live[0] || r.archived[0];
      if (first) act('ses:' + first.id);
    }
  }, true);
}
