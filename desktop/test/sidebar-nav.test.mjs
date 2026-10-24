import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const {sidebarNavItems, railGlyph, toggleSidebar, sidebarToggleView} = createRequire(import.meta.url)('../renderer/sidebar-nav.js');

// ATO-457 (U-24): Tasks and Skills are standing rows, whatever the agent holds.
test('the section rows are Tasks then Skills, reaching the ⌘ 2 / ⌘ 3 verbs', () => {
  const items = sidebarNavItems(null);
  assert.deepEqual(items.map((n) => n.label), ['Tasks', 'Skills']);
  assert.deepEqual(items.map((n) => n.act), ['room:tasks', 'room:skills']);
  assert.deepEqual(items.map((n) => n.chord), ['⌘ 2', '⌘ 3']);
  assert.ok(items.every((n) => !n.on), 'nothing is lit while Settings is closed');
});

test('the row whose Settings tab is open is the lit one', () => {
  assert.deepEqual(sidebarNavItems('tasks').map((n) => n.on), [true, false]);
  assert.deepEqual(sidebarNavItems('skills').map((n) => n.on), [false, true]);
  assert.deepEqual(sidebarNavItems('memory').map((n) => n.on), [false, false]);
});

test('the View menu and the section rows name the same ⌘ 2 / ⌘ 3 places', () => {
  const menu = readFileSync(new URL('../main/menu.ts', import.meta.url), 'utf8');
  assert.match(menu, /item\("Tasks", "room:tasks", "CommandOrControl\+2"\)/);
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

// ATO-900: the owner saw "Studio" run past the rail's edge and the chats ragged.
test('the rail shows no Studio header word and draws every row as one 32px cell', () => {
  const shell = readFileSync(new URL('../renderer/css/shell.css', import.meta.url), 'utf8');
  const studio = readFileSync(new URL('../renderer/css/studio.css', import.meta.url), 'utf8');
  for (const scope of ['#sidebar\\.rail', '#sidebar:not\\(\\.drawer\\)']) {
    assert.match(studio, new RegExp(scope + ' \\.sb-studio-head\\{display:none\\}'), `${scope}: the Studio header is hidden`);
    assert.match(shell, new RegExp(scope + ' \\.sesrow\\{[^}]*width:32px;height:32px'), `${scope}: a chat row is a 32px cell`);
    assert.match(shell, new RegExp(scope + ' \\.sb-new\\{width:32px;height:32px'), `${scope}: New chat, the section rows and Studio are 32px cells`);
  }
  const narrow = studio.slice(studio.indexOf('@media (max-width:1000px){'));
  assert.match(narrow, /#sidebar:not\(\.drawer\) \.sb-studio-head\{display:none\}/, 'Studio follows the 1000px breakpoint shell.css uses');
  assert.doesNotMatch(studio, /max-width:999px/);
});
