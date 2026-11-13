// ATO-1150: search and archive in the sidebar's chat list. The pure half is
// renderer/chat-list.js; the renderer half (chat-search.js) is checked for
// its wiring only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const {archiveSet, splitArchived, chatSearchQuery, chatSearch, chatMenuItems, orderChats, CHAT_SEARCH_MAX,
  archivedIdsOf, agentKeepsArchive, archiveMigrationStep} =
  createRequire(import.meta.url)('../renderer/chat-list.js');

const ses = (id, t = id) => ({id, t, updatedAt: 1});
const ids = (rows) => rows.map((r) => r.id);

test('archiveSet adds an id once, newest first, and takes it out again', () => {
  assert.deepEqual(archiveSet([], 'a', true), ['a']);
  assert.deepEqual(archiveSet(['a'], 'b', true), ['b', 'a']);
  assert.deepEqual(archiveSet(['b', 'a'], 'a', true), ['a', 'b']);
  assert.deepEqual(archiveSet(['b', 'a'], 'a', false), ['b']);
  assert.deepEqual(archiveSet(['b'], 'x', false), ['b']);
  // A stale or hand-edited prefs.json: non-strings and empties are dropped, a missing list is none.
  assert.deepEqual(archiveSet(['b', 3, '', null], 'c', true), ['c', 'b']);
  assert.deepEqual(archiveSet(undefined, 'c', true), ['c']);
  assert.deepEqual(archiveSet(['b'], '', true), ['b']);
});

test('splitArchived keeps the given order on both sides', () => {
  const rows = [ses('a'), ses('b'), ses('c'), ses('d')];
  const out = splitArchived(rows, ['c', 'a', 'gone']);
  assert.deepEqual(ids(out.live), ['b', 'd']);
  assert.deepEqual(ids(out.archived), ['a', 'c']);
  assert.deepEqual(ids(splitArchived(rows, undefined).live), ['a', 'b', 'c', 'd']);
});

test('an archived chat is on none of the main lists, Pinned included, once split before orderChats', () => {
  const rows = [ses('a'), ses('b'), ses('c')];
  const arch = splitArchived(rows, ['b']);
  const order = orderChats(arch.live, [], ['b', 'c']);
  assert.deepEqual(ids(order.pinned), ['c']);
  assert.deepEqual(ids(order.rest), ['a']);
});

test('the archived ids: the rows the agent flags, plus the ones prefs.json still holds, once each', () => {
  const rows = [{id: 'a', archived: true}, {id: 'b', archived: false}, {id: 'c'}];
  assert.deepEqual(archivedIdsOf(rows, []).sort(), ['a']);
  assert.deepEqual(archivedIdsOf(rows, ['c', 'a', '', 7]).sort(), ['a', 'c']);
  assert.deepEqual(archivedIdsOf(undefined, undefined), []);
  // Only a literal true from the agent counts.
  assert.deepEqual(archivedIdsOf([{id: 'x', archived: 'true'}], []), []);
});

test('whether the agent keeps the flag, read from its list', () => {
  assert.equal(agentKeepsArchive([{id: 'a', archivedKnown: true, archived: false}]), true);
  // An agent from before the route sends no field: the prefs.json fallback.
  assert.equal(agentKeepsArchive([{id: 'a', archivedKnown: false}, {id: 'b'}]), false);
  // No rows yet: not known.
  assert.equal(agentKeepsArchive([]), null);
  assert.equal(agentKeepsArchive(undefined), null);
});

test('moving prefs.json ids to the agent: moved, kept for later, or stopped', () => {
  assert.equal(archiveMigrationStep({supported: true, ok: true, archived: true}), 'moved');
  // The agent does not hold that chat (deleted elsewhere): nothing to keep.
  assert.equal(archiveMigrationStep({supported: true, ok: false, notFound: true, error: 'session not found'}), 'moved');
  // The agent is down or refused: try again next launch.
  assert.equal(archiveMigrationStep({supported: true, ok: false, notFound: false, error: 'timeout'}), 'keep');
  assert.equal(archiveMigrationStep(undefined), 'keep');
  // No route after all ("No route for"): every id stays in prefs.json.
  assert.equal(archiveMigrationStep({supported: false}), 'stop');
});

test('the query is trimmed, lowercased and its spaces collapsed; blank is no search', () => {
  assert.equal(chatSearchQuery('  Deploy   The  '), 'deploy the');
  assert.equal(chatSearchQuery('   '), '');
  assert.equal(chatSearchQuery(null), '');
  const r = chatSearch('  ', [ses('a')], []);
  assert.deepEqual(r, {q: '', live: [], archived: [], total: 0});
});

test('search finds chats by title with the palette ranking, best first', () => {
  const rows = [ses('1', 'Fix login bug'), ses('2', 'site deploy notes'), ses('3', 'Deploy the site'), ses('4', 'Random')];
  const r = chatSearch('deploy', rows, []);
  // Prefix of the title (rank 1) before a word prefix (rank 2).
  assert.deepEqual(ids(r.live), ['3', '2']);
  assert.equal(r.total, 2);
  // Case does not matter.
  assert.deepEqual(ids(chatSearch('LOGIN', rows, []).live), ['1']);
  // One swapped pair of letters still finds it (fuzzy-match.js typo tier).
  assert.ok(ids(chatSearch('delpoy', rows, []).live).includes('3'));
  // Nothing matches: empty results, nothing else drawn from them.
  assert.deepEqual(chatSearch('zzzz', rows, []), {q: 'zzzz', live: [], archived: [], total: 0});
});

test('archived chats are found too, and kept apart from the others', () => {
  const rows = [ses('1', 'Deploy the site'), ses('2', 'Deploy notes'), ses('3', 'Other')];
  const r = chatSearch('deploy', rows, ['2']);
  assert.deepEqual(ids(r.live), ['1']);
  assert.deepEqual(ids(r.archived), ['2']);
  assert.equal(r.total, 2);
});

test('a chat is matched once (the stored row, listed first, wins over a stand-in)', () => {
  const rows = [ses('a', 'Deploy stored'), {id: 'a', t: 'Deploy stand-in'}, ses('b', 'Deploy b')];
  const r = chatSearch('deploy', rows, []);
  assert.deepEqual(ids(r.live), ['a', 'b']);
  assert.equal(r.live[0].t, 'Deploy stored');
});

test('results stop at CHAT_SEARCH_MAX, the total still counts every match', () => {
  const rows = Array.from({length: CHAT_SEARCH_MAX + 7}, (_, i) => ses('c' + i, 'chat ' + i));
  const r = chatSearch('chat', rows, []);
  assert.equal(r.live.length, CHAT_SEARCH_MAX);
  assert.equal(r.total, CHAT_SEARCH_MAX + 7);
});

test('the row menu: Archive for a stored chat, Unarchive (and no Pin) for an archived one', () => {
  assert.deepEqual(chatMenuItems({archivable: true}).map((i) => i.verb), ['pin', 'unread', 'rename', 'archive', 'delask']);
  assert.deepEqual(chatMenuItems({archivable: true, archived: true, folders: true}).map((i) => i.verb),
    ['unread', 'rename', 'fpick', 'unarchive', 'delask']);
  // A new chat's stand-in has nothing stored to archive; the old callers are unchanged.
  assert.deepEqual(chatMenuItems({renamable: false, archivable: false}).map((i) => i.verb), ['pin', 'unread', 'delask']);
  assert.deepEqual(chatMenuItems({}).map((i) => i.verb), ['pin', 'unread', 'rename', 'delask']);
  const it = chatMenuItems({archivable: true}).find((i) => i.verb === 'archive');
  assert.equal(it.label, 'Archive');
  assert.ok(!it.danger);
});

test('wiring: chat-search.js loads after chat-list.js and before renderer.js; the sidebar, menu, delete and prefs use it', () => {
  const html = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  const at = (f) => html.indexOf('<script src="' + f + '"');
  assert.ok(at('chat-list.js') > 0 && at('chat-search.js') > at('chat-list.js') && at('chat-search.js') < at('renderer.js'));
  const src = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  assert.match(src, /chatSearchFieldHTML\(\)/);
  assert.match(src, /chatSearchOn\(\) \? chatSearchListsHTML\(\)/);
  assert.match(src, /archivedSidebarHTML\(ch\.archived\)/);
  assert.match(src, /splitArchived\(SESSIONS, chatArchivedIds\(\)\)/);
  assert.match(src, /archived:x\.archived === true, archivedKnown:typeof x\.archived === 'boolean'/);
  assert.match(src, /archivesAfterSessions\(\);  \/\/ ATO-1150/);
  assert.match(src, /chatSearchHold\(\)/);
  assert.match(src, /chatSearchRestore\(searchHeld\)/);
  assert.match(src, /archivable: stored, archived: chatArchivedIds\(\)\.includes\(id\)/);
  assert.match(src, /if \(chatArchiveAct\(k, v, close\)\) return;/);
  assert.match(src, /PREFS\.archived = archiveSet\(PREFS\.archived, v, false\)/);
  assert.match(src, /archived:PREFS\.archived\.slice\(\)/);
  assert.match(src, /\barchive:'<rect/);
  const ui = readFileSync(new URL('../renderer/chat-search.js', import.meta.url), 'utf8');
  assert.match(ui, /BR\.setSessionArchived\(id, on\)/);
  assert.match(ui, /res\.supported === false/);
  const client = readFileSync(new URL('../main/agent-client.ts', import.meta.url), 'utf8');
  assert.match(client, /\/api\/sessions\/\$\{encodeURIComponent\(id\)\}\/archived/);
  assert.match(client, /res\.status === 404 && \/No route for\/\.test\(text\)\) return \{ supported: false \};\n      if \(res\.ok\)/);
  const preload = readFileSync(new URL('../preload/preload.ts', import.meta.url), 'utf8');
  assert.match(preload, /setSessionArchived: \(id: string, archived: boolean\) => ipcRenderer\.invoke\("agent:setSessionArchived"/);
  const main = readFileSync(new URL('../main/main.ts', import.meta.url), 'utf8');
  assert.match(main, /ipcMain\.handle\("agent:setSessionArchived"/);
  assert.match(main, /archived: string\[\] \};/);
  assert.match(main, /Array\.isArray\(src\.archived\)/);
});
