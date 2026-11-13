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
   the chats; Unarchive (same menu) puts it back where it was. Archiving unpins.
   The flag is the agent's (`metadata.archived`, POST /api/sessions/{id}/archived),
   in the shared state dir, so the terminal's rail leaves the same chats out.
   Against an agent from before that route ("No route for") the window keeps
   archived ids in userData/prefs.json beside the pins, as a fallback; once the
   agent has the route, those ids are moved to it, once per launch
   (archivesAfterSessions).

   The sidebar is rebuilt whole on every render, so the field's text lives in
   CHATSEARCH.q and its focus and caret are carried across the rebuild
   (chatSearchHold / chatSearchRestore around renderSidebar's write). */

/* `agent`: whether the agent keeps the archive flag (null: not known yet).
   `migrating`: the prefs.json ids are being moved to the agent. */
const CHATSEARCH = {q: '', archOpen: false, agent: null, migrating: false};

/** The archived chat ids, from the agent's rows and the window's own fallback list. */
function chatArchivedIds() {
  return archivedIdsOf(SESSIONS, PREFS.archived);
}

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
  const r = chatSearch(CHATSEARCH.q, chatSearchRows(), chatArchivedIds());
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

/* Archive (`on`) or unarchive chat `id`; returns whether anything changed.
   The row moves at once; the agent's answer confirms it, or puts it back
   with a toast. An agent without the route gets the prefs.json list instead. */
function chatArchive(id, on) {
  const row = SESSIONS.find((s) => s.id === id);
  if (!id || !row) return false;
  on = !!on;
  if (chatArchivedIds().includes(id) === on) return false;
  if (on) PREFS.pinned = PREFS.pinned.filter((x) => x !== id);   // an archived chat is not on the main list, Pinned included
  toast(on ? 'Chat archived' : 'Chat unarchived', row.t || '');
  if (CHATSEARCH.agent === false || !BR || !BR.setSessionArchived) {
    archiveInPrefs(id, on);
    return true;
  }
  const wasRow = row.archived === true, wasPrefs = PREFS.archived.includes(id);
  row.archived = on;
  // The agent holds the flag now: the window's own copy goes, whichever way.
  if (wasPrefs) PREFS.archived = archiveSet(PREFS.archived, id, false);
  savePrefs();
  BR.setSessionArchived(id, on).then((res) => {
    if (res && res.supported === false) {   // an agent from before the route: the fallback list
      CHATSEARCH.agent = false;
      row.archived = wasRow;
      archiveInPrefs(id, on);
      render(); nameVisibleSessions();
      return;
    }
    if (res && res.ok) return;
    row.archived = wasRow;
    if (wasPrefs) { PREFS.archived = archiveSet(PREFS.archived, id, true); savePrefs(); }
    render(); nameVisibleSessions();
    toast(on ? 'Could not archive the chat' : 'Could not unarchive the chat', (res && res.error) || '');
  });
  return true;
}

function archiveInPrefs(id, on) {
  PREFS.archived = archiveSet(PREFS.archived, id, on);
  savePrefs();
}

/* After each read of the chat list (applySessions) and of prefs.json
   (loadPrefs): learn whether the agent keeps the flag, and when it does,
   move the ids prefs.json still holds to it, once per launch. Each id
   leaves prefs.json when the agent took it (or does not hold that chat);
   one the agent could not take now stays for the next launch. */
function archivesAfterSessions() {
  const keeps = agentKeepsArchive(SESSIONS);
  if (keeps !== null) CHATSEARCH.agent = keeps;
  if (CHATSEARCH.agent !== true || CHATSEARCH.migrating || !PREFS.loaded || !PREFS.archived.length) return;
  if (!BR || !BR.setSessionArchived) return;
  CHATSEARCH.migrating = true;
  const ids = PREFS.archived.slice();
  (async () => {
    for (const id of ids) {
      const res = await BR.setSessionArchived(id, true);
      const step = archiveMigrationStep(res);
      if (step === 'stop') { CHATSEARCH.agent = false; break; }
      if (step !== 'moved') continue;
      const row = SESSIONS.find((s) => s.id === id);
      if (row && res.ok) row.archived = true;
      PREFS.archived = archiveSet(PREFS.archived, id, false);
    }
    savePrefs();
    render();
  })();
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
      const r = chatSearch(CHATSEARCH.q, chatSearchRows(), chatArchivedIds());
      const first = r.live[0] || r.archived[0];
      if (first) act('ses:' + first.id);
    }
  }, true);
}
