import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const {sidebarNavItems, railGlyph, toggleSidebar, sidebarToggleView, lucideIcon, studioMenuItems, LUCIDE} = createRequire(import.meta.url)('../renderer/sidebar-nav.js');

// ATO-457 (U-24), W2: under Studio, Cron jobs (the Tasks tab), Skills and Plugins are standing rows, whatever the agent holds.
test('the section rows are Cron jobs, Skills, Plugins, reaching the ⌘ 2 / ⌘ 3 verbs and Settings › Plugins', () => {
  const items = sidebarNavItems(null);
  assert.deepEqual(items.map((n) => n.label), ['Cron jobs', 'Skills', 'Plugins']);
  assert.deepEqual(items.map((n) => n.id), ['tasks', 'skills', 'plugins'], 'the internal ids stay');
  assert.deepEqual(items.map((n) => n.act), ['room:tasks', 'room:skills', 'settings:plugins']);
  assert.deepEqual(items.map((n) => n.chord), ['⌘ 2', '⌘ 3', '']);
  assert.deepEqual(items.map((n) => n.icon), ['timer', 'bookOpen', 'puzzle']);
  assert.ok(items.every((n) => !n.on), 'nothing is lit while Settings is closed');
  // The old {projects} option no longer adds a New project row.
  assert.deepEqual(sidebarNavItems(null, {projects: true}).map((n) => n.label), ['Cron jobs', 'Skills', 'Plugins']);
});

test('the row whose Settings tab is open is the lit one', () => {
  assert.deepEqual(sidebarNavItems('tasks').map((n) => n.on), [true, false, false]);
  assert.deepEqual(sidebarNavItems('skills').map((n) => n.on), [false, true, false]);
  assert.deepEqual(sidebarNavItems('plugins').map((n) => n.on), [false, false, true]);
  assert.deepEqual(sidebarNavItems('memory').map((n) => n.on), [false, false, false]);
});

// W2: the top rows draw thin Lucide glyphs, 24px grid at 1.5 stroke.
test('every row icon is a Lucide glyph at stroke 1.5; an unknown name draws nothing', () => {
  for (const n of ['plus', 'sparkles', 'timer', 'bookOpen', 'puzzle', 'image', 'video', 'folderPlus']) {
    const svg = lucideIcon(n);
    assert.match(svg, /viewBox="0 0 24 24"/, n);
    assert.match(svg, /stroke-width="1\.5"/, n);
    assert.match(svg, /aria-hidden="true"/, n);
    assert.ok(svg.includes(LUCIDE[n]), n);
  }
  for (const n of sidebarNavItems(null)) assert.ok(lucideIcon(n.icon), n.label);
  assert.equal(lucideIcon('nope'), '');
});

test('the Studio popover offers Image then Video, each opening its existing page', () => {
  assert.deepEqual(studioMenuItems(['images', 'video']).map((i) => [i.label, i.act, i.icon]),
    [['Image', 'studio:open:images', 'image'], ['Video', 'studio:open:video', 'video']]);
  assert.deepEqual(studioMenuItems(['images']).map((i) => i.label), ['Image']);
  assert.deepEqual(studioMenuItems([]), []);
});

test('the sidebar draws one Studio row first in the section rows, and its popover hangs off <body>', () => {
  const shell = readFileSync(new URL('../renderer/studio/shell.js', import.meta.url), 'utf8');
  assert.match(shell, /data-act="studio:menu" data-nav="studio"/);
  assert.match(shell, /lu\('sparkles'\)/);
  assert.doesNotMatch(shell, /sb-studio-head/, 'no "Studio" header any more');
  assert.match(shell, /if \(head === 'menu'\) \{ STUDIO\.toggleMenu\(\); return; \}/);
  assert.match(shell, /document\.body\.appendChild\(el\)/);
  const r = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  assert.match(r, /'<div class="sb-nav" role="group" aria-label="Sections">'\s*\n\s*\+ \(window\.STUDIO \? STUDIO\.sidebarHTML\(S\.room\) : ''\)\s*\n\s*\+ sidebarNavItems\(pane\)/);
  assert.doesNotMatch(r, /\+ sidebarNavHTML\(\)[^\n]*\n\s*\/\/ Studio: the Images and Video rows/);
  // A click on the Studio row in the narrow window's drawer keeps the drawer, its popover hangs off it.
  assert.match(r, /\[data-act="studio:menu"\], \[data-act\^="chatsearch:"\], \.sb-top \[data-act="palette"\], \[data-more\]/);
});

test('the View menu and the section rows name the same ⌘ 2 / ⌘ 3 places', () => {
  const menu = readFileSync(new URL('../main/menu.ts', import.meta.url), 'utf8');
  assert.match(menu, /item\("Cron jobs", "room:tasks", "CommandOrControl\+2"\)/);
  assert.match(menu, /item\("Skills", "room:skills", "CommandOrControl\+3"\)/);
});

// ATO-538 (U-106): rail rows differ at a glance.
test('a rail glyph is the first letter of the title, upper-cased', () => {
  assert.equal(railGlyph('refactor the parser'), 'R');
  assert.equal(railGlyph('Plan the trip'), 'P');
  assert.equal(railGlyph('привет'), 'П');
});

test('leading punctuation and spaces are skipped; a digit counts', () => {
  assert.equal(railGlyph('  "quoted" title'), 'Q');
  assert.equal(railGlyph('#2 bug in login'), '2');
  assert.equal(railGlyph('…and then'), 'A');
});

test('an emoji keeps its whole grapheme', () => {
  assert.equal(railGlyph('🚀 launch plan'), '🚀');
  assert.equal(railGlyph('👍🏽 thanks'), '👍🏽');
  assert.equal(railGlyph('🇩🇪 trip'), '🇩🇪');
});

test('a title with nothing to show gets no glyph, so the row keeps its plain dot', () => {
  assert.equal(railGlyph(''), '');
  assert.equal(railGlyph('   ...'), '');
  assert.equal(railGlyph(null), '');
  assert.equal(railGlyph(undefined), '');
});

test('two chats with different titles draw different glyphs (they used to be the same dot)', () => {
  assert.notEqual(railGlyph('Fix the build'), railGlyph('Write the release notes'));
});

// ATO-538 (U-106): the toggle on a narrow window opens a drawer instead of refusing.
test('on a wide window the toggle flips the kept collapse and never leaves a drawer', () => {
  assert.deepEqual(toggleSidebar({narrow: false, sidebar: 'open', drawer: false}), {sidebar: 'rail', drawer: false});
  assert.deepEqual(toggleSidebar({narrow: false, sidebar: 'rail', drawer: false}), {sidebar: 'open', drawer: false});
  assert.deepEqual(toggleSidebar({narrow: false, sidebar: 'open', drawer: true}), {sidebar: 'rail', drawer: false});
});

test('on a narrow window (940-1000px) the toggle opens and closes the drawer, keeping the collapse', () => {
  assert.deepEqual(toggleSidebar({narrow: true, sidebar: 'open', drawer: false}), {sidebar: 'open', drawer: true});
  assert.deepEqual(toggleSidebar({narrow: true, sidebar: 'open', drawer: true}), {sidebar: 'open', drawer: false});
  assert.deepEqual(toggleSidebar({narrow: true, sidebar: 'rail', drawer: false}), {sidebar: 'rail', drawer: true});
});

test('the toggle is lit while the full sidebar is on screen, and says what a press does', () => {
  assert.deepEqual(sidebarToggleView({narrow: false, sidebar: 'open'}), {open: true, label: 'Hide sidebar (⌘ \\)'});
  assert.deepEqual(sidebarToggleView({narrow: false, sidebar: 'rail'}), {open: false, label: 'Show sidebar (⌘ \\)'});
  assert.deepEqual(sidebarToggleView({narrow: true, sidebar: 'open', drawer: false}), {open: false, label: 'Show sidebar (⌘ \\)'});
  assert.deepEqual(sidebarToggleView({narrow: true, sidebar: 'rail', drawer: true}), {open: true, label: 'Hide sidebar (⌘ \\)'});
});

test('the responsive rail rules give way to the drawer, and the rail paints the glyph', () => {
  const css = readFileSync(new URL('../renderer/css/shell.css', import.meta.url), 'utf8');
  const narrow = css.slice(css.indexOf('@media (max-width:1000px){'));
  assert.match(narrow, /#sidebar:not\(\.drawer\)\{width:52px/);
  assert.match(narrow, /#sidebar\.drawer\{width:260px;margin-right:-208px/);
  assert.doesNotMatch(narrow.slice(0, narrow.indexOf('\n}\n')), /\n  #sidebar\{width:52px/, 'a bare #sidebar rule would pin the drawer to 52px');
  assert.match(css, /#sidebar\.rail \.sesrow\[data-g\]::before\{\s*content:attr\(data-g\)/);
});

// ATO-900: the owner saw "Studio" run past the rail's edge and the chats ragged. W2: Studio is one row now, no header at all.
test('the rail draws every row as one 32px cell, Studio included, and its working dot stays on the row', () => {
  const shell = readFileSync(new URL('../renderer/css/shell.css', import.meta.url), 'utf8');
  const studio = readFileSync(new URL('../renderer/css/studio.css', import.meta.url), 'utf8');
  for (const scope of ['#sidebar\\.rail', '#sidebar:not\\(\\.drawer\\)']) {
    assert.match(studio, new RegExp(scope + ' \\.sb-studio-row \\.sb-studio-dot\\{position:absolute'), `${scope}: the working dot is a badge on the Studio cell`);
    assert.match(shell, new RegExp(scope + ' \\.sesrow\\{[^}]*width:32px;height:32px'), `${scope}: a chat row is a 32px cell`);
    assert.match(shell, new RegExp(scope + ' \\.sb-new\\{width:32px;height:32px'), `${scope}: New chat, Studio and the section rows are 32px cells`);
    assert.match(shell, new RegExp(scope + ' \\.sb-projects-empty\\{display:none\\}'), `${scope}: an empty Projects block draws nothing in the rail`);
    assert.match(shell, new RegExp(scope + ' \\.sb-projects-empty:first-child \\+ \\.sb-list::before\\{display:none\\}'), `${scope}: no divider over the list after an empty Projects block`);
  }
  assert.doesNotMatch(studio, /sb-studio-head/);
  assert.doesNotMatch(studio, /max-width:999px/);
});

// ATO-1146, W2: "New project" left the rows under New chat; it is the small button on the Projects header.
test('New project is the Projects header button, drawn whenever the projects store is there', () => {
  const src = readFileSync(new URL('../renderer/chat-projects.js', import.meta.url), 'utf8');
  assert.match(src, /if \(!projectsSupported\(\)\) return '';/);
  assert.match(src, /<span>Projects<\/span>'\s*\n\s*\+ '<button class="iconbtn sb-add sb-pnew" data-act="pnew:" title="New project" aria-label="New project">' \+ plus/);
  assert.match(src, /lucideIcon\('folderPlus'\)/);
  assert.ok(!sidebarNavItems(null, {projects: true}).some((n) => n.act === 'pnew:'), 'no New project row under New chat');
});

// W2 QA (owner): one search for the whole app; the sidebar's magnifier opens the palette.
test('the sidebar magnifier opens the one search and no Search chats field is opened', () => {
  const cs = readFileSync(new URL('../renderer/chat-search.js', import.meta.url), 'utf8');
  assert.match(cs, /if \(!has && !CHATSEARCH\.open\) return '';/);
  assert.match(cs, /if \(v === 'open'\) \{ CHATSEARCH\.open = false; CHATSEARCH\.q = ''; act\('palette'\); return true; \}/);
  const r = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  assert.match(r, /'<div class="sb-top">' \+ searchBtnHTML\(true\) \+ sidebarToggleHTML\(\)/);
  assert.match(r, /data-act="palette" title="' \+ title \+ '"/);
  assert.match(r, /kbdText\('Search \(⌘ K\)'\)/);
  assert.ok(!/data-act="chatsearch:open"/.test(r), 'no separate chat search button');
  // The narrow window's drawer draws the magnifier too (sidebarExpanded() is false there), and a click on it keeps the drawer.
  assert.match(r, /: drawer \? '<div class="sb-top">' \+ searchBtnHTML\(true\) \+ '<\/div>' : ''\)/);
  assert.match(r, /\[data-act\^="chatsearch:"\]/);
  const shell = readFileSync(new URL('../renderer/css/shell.css', import.meta.url), 'utf8');
  assert.match(shell, /#sidebar:not\(\.drawer\) \.sb-top\{display:none\}/, 'the narrow rail hides the row, the drawer keeps it');
  assert.match(shell, /#sidebar\.drawer \.sb-top\{/);
  assert.match(r, /\(open \? '' : sidebarToggleHTML\(\) \+ searchBtnHTML\(\)\)/, 'the toolbar magnifier (rail) is still the palette');
});

test('the sidebar wires the projects module: loaded before renderer.js, drawn above the folders', () => {
  const html = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  const at = (s) => html.indexOf('<script src="' + s + '"></script>');
  assert.ok(at('chat-projects.js') > at('chat-list.js') && at('chat-projects.js') < at('renderer.js'));
  const r = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
  assert.match(r, /projectsSidebarHTML\(ch\.projects, ch\.groups\)/);
  assert.match(r, /projectGroups\(PROJECTS\.state, order\.rest, FOLDERS\.state, homeDir\(\)\)/);
  assert.match(r, /folderGroups\(FOLDERS\.state, pg\.rest\)/);
  assert.match(r, /sidebarNavItems\(pane\)/);
  assert.match(r, /k === 'pnew' \|\| k === 'ptoggle' \|\| k === 'pdelask' \|\| k === 'pdel' \|\| k === 'pedit' \|\| k === 'psave'/);
  // A new chat New project opened sends its project with the first turn (ATO-42: main files it before the turn).
  assert.match(r, /const forProject = session \? undefined : projectForNewTurn\(\);/);
  assert.match(r, /BR\.chat\(\[\{role:'user', content:text\}\], session, forProject, reasoningTurnLevel\(session\), projectTurnModel\(session\)\)/);
  assert.match(r, /S\.overlay === 'pedit'\) html \+= projectEditHTML\(\)/);
});

test('the Edit project sheet keeps to the store limits and saves name and instructions by id', () => {
  const src = readFileSync(new URL('../renderer/chat-projects.js', import.meta.url), 'utf8');
  assert.match(src, /PROJECT_INSTRUCTIONS_MAX = 16000/);
  assert.match(src, /projectsSave\(\{id: e\.id, name, instructions: e\.instructions\}\)/);
  assert.match(src, /res && res\.error/, 'the error main returns is shown');
});
