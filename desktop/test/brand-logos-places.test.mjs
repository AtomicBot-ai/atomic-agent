// ATO-1633: places that named a brand next to a generic icon now draw the
// mark that already ships in renderer/logos/, through renderer.js's one
// helper (logoHTML / providerMark / modelMark): the sidebar's import
// folders, the handoff sheet, the palette's "Continue from…" row, MCP and
// GitHub tool glyphs, Studio's image models, the fit test, the plugins
// pane, the GitHub webhook preset and Composio's GitHub mention.
//
// Without renderer.js loaded (the other Node checks) every place keeps its
// old glyph or text, so those checks are untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createContext, runInContext } from 'node:vm';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');

function fn(name) {
  const at = source.indexOf('\nfunction ' + name + '(');
  assert.ok(at >= 0, name + ' is a top-level function in renderer.js');
  return source.slice(at + 1, source.indexOf('\n}\n', at) + 2);
}
function constBlock(name) {
  const at = source.indexOf('\nconst ' + name + ' = {');
  assert.ok(at >= 0, name + ' is a top-level const in renderer.js');
  return source.slice(at + 1, source.indexOf('\n};\n', at) + 3);
}

/** renderer.js's mark helpers, in a vm. */
function helpers(extra = {}) {
  const ctx = createContext({ ic: (n) => '<i:' + n + '>', esc: (s) => String(s), ...extra });
  runInContext([
    constBlock('LOGO_FILES'), constBlock('PROVIDER_LOGO_KEYS'),
    fn('modelLogoKey'), fn('providerLogoKey'), fn('logoHTML'), fn('markFallbackHTML'), fn('modelMark'), fn('providerMark'),
    fn('toolLogoKey'), fn('toolIcon'), fn('toolGlyphHTML'), fn('palIconHTML'),
    'this.LOGO_FILES = LOGO_FILES;',
  ].join('\n'), ctx);
  return ctx;
}
const H = helpers();
const img = (html) => (String(html).match(/src="logos\/([^"]+)"/) || [])[1] || '';
const known = (key) => Object.prototype.hasOwnProperty.call(H.LOGO_FILES, key);

test('every mark key the places use is a file in renderer/logos/', () => {
  const F = require('../renderer/chat-folders.js');
  const W = require('../renderer/webhooks.js');
  const P = require('../renderer/plugins-pane.js');
  const D = require('../renderer/handoff.js');
  const keys = [
    ...Object.values(F.FOLDER_SOURCE_LOGOS), ...Object.values(W.WHK_PRESET_LOGOS),
    ...Object.values(P.PLG_FORMAT_LOGOS), ...Object.values(D.HANDOFF_AGENT_LOGOS), 'claudecode', 'github', 'ollama', 'lmstudio',
  ];
  for (const k of keys) assert.ok(known(k), k);
  // Every app the import can file chats from has a mark.
  for (const src of Object.keys(F.FOLDER_SOURCES)) assert.ok(F.FOLDER_SOURCE_LOGOS[src], src);
});

test('a sidebar folder of one imported app wears that app, the person\'s own folder keeps the folder glyph', () => {
  const F = require('../renderer/chat-folders.js');
  const state = F.foldersCoerce({ folders: [{ id: 'f1', name: 'Codex' }, { id: 'f2', name: 'my-app' }, { id: 'f3', name: 'Work' }], projects: { f2: '/src/my-app' } });
  // The app's own folder, by the chats in it; a folder the person named "Codex" with none is not branded.
  assert.equal(F.folderLogoKey(state.folders[0], [{ id: 'codex:1' }, { id: 'codex:2' }]), 'codex');
  assert.equal(F.folderLogoKey(state.folders[0], []), '');
  assert.equal(F.folderLogoKey(state.folders[0], [{ id: 's-9' }]), '');
  // A Claude Code project folder: every chat in it came from Claude Code.
  assert.equal(F.folderLogoKey(state.folders[1], [{ id: 'claude-code:a' }, { id: 'claude-code:b' }]), 'claudecode');
  assert.equal(F.folderLogoKey(state.folders[2], [{ id: 'pi:x' }]), 'pi');
  assert.equal(F.folderLogoKey(state.folders[2], [{ id: 'oh-my-pi:x' }]), 'ohmypi');
  assert.equal(F.folderLogoKey(state.folders[2], [{ id: 'hermes:x' }]), 'hermes');
  assert.equal(F.folderLogoKey(state.folders[2], [{ id: 'openclaw:x' }]), 'openclaw');
  assert.equal(F.folderLogoKey(state.folders[2], [{ id: 'claude-app:x' }]), 'claude');
  // A mix, the person's own chats, or nothing: no mark.
  assert.equal(F.folderLogoKey(state.folders[2], [{ id: 'codex:a' }, { id: 'pi:b' }]), '');
  assert.equal(F.folderLogoKey(state.folders[2], [{ id: 'codex:a' }, { id: 's-123' }]), '');
  assert.equal(F.folderLogoKey(state.folders[2], []), '');
});

test('the handoff sheet\'s choices and rows wear Claude Code and Codex', () => {
  const D = require('../renderer/handoff.js');
  assert.equal(D.handoffMark('claude-code', 'xs'), '', 'no renderer.js: no mark');
  globalThis.logoHTML = H.logoHTML;
  try {
    assert.equal(img(D.handoffMark('claude-code', 'xs')), 'claudecode-color.svg');
    assert.equal(img(D.handoffMark('codex', 'sm')), 'codex-color.svg');
    assert.equal(D.handoffMark('other', 'sm'), '');
  } finally { delete globalThis.logoHTML; }
});

test('the palette row "Continue from Claude Code / Codex" wears the Claude Code mark', () => {
  assert.match(source, /\['logo:claudecode','Continue from Claude Code \/ Codex…'/);
  assert.equal(img(H.palIconHTML('logo:claudecode')), 'claudecode-color.svg');
  assert.equal(H.palIconHTML('chat'), '<i:chat>');
  assert.equal(H.palIconHTML('logo:nope'), '<i:import>');
});

test('GitHub and MCP tools wear their brand, the rest keep the tool icon', () => {
  assert.equal(H.toolLogoKey('github.issue.create'), 'github');
  assert.equal(H.toolLogoKey('mcp.github.create_issue'), 'github');
  assert.equal(H.toolLogoKey('mcp.my-github.search'), 'github');
  assert.equal(H.toolLogoKey('mcp.openrouter.models'), 'openrouter');
  assert.equal(H.toolLogoKey('mcp.resource.list'), '');
  assert.equal(H.toolLogoKey('mcp.files.read'), '');
  assert.equal(H.toolLogoKey('os.fs.read'), '');
  assert.equal(img(H.toolGlyphHTML('mcp.github.create_issue')), 'github.svg');
  assert.match(H.toolGlyphHTML('mcp.github.create_issue'), /data-fb="plug"/);
  assert.equal(H.toolGlyphHTML('os.fs.read'), '<i:file>');
  assert.equal(H.toolGlyphHTML('mcp.files.read'), '<i:plug>');
});

test('a Fusion worker\'s feed line and the new-model card wear the model\'s mark', () => {
  const c = helpers({ modelBlurb: () => 'A small model', modelSizeWord: () => '5 GB', llmModelName: (m) => m.name });
  runInContext(fn('sysGlyph') + fn('modelSpotlightCardHTML'), c);
  assert.equal(img(c.sysGlyph({ fusion: true, fzModel: 'qwen3-8b' })), 'qwen-color.svg');
  assert.equal(c.sysGlyph({ fusion: true, fzModel: 'llama-3b' }), '<span class="sys-ic"><i:fusion></span>', 'no mark: the Fusion glyph');
  assert.equal(c.sysGlyph({ fusion: true }), '<span class="sys-ic"><i:fusion></span>');
  assert.match(c.sysGlyph({ fusion: true, fzModel: 'qwen3-8b', sev: 'err' }), /<i:alert>/, 'a failure keeps its red glyph');
  assert.equal(img(c.modelSpotlightCardHTML({ id: 'gemma4-e4b', name: 'Gemma 4 E4B' })), 'google.svg');
  assert.match(c.modelSpotlightCardHTML({ id: 'llama-3b', name: 'Llama 3B' }), /dlc-ttl"><i:download>/);
  // The live strip draws the same mark beside each worker's line.
  assert.match(source, /'<span class="fzdot"><\/span>' \+ logoHTML\(modelLogoKey\(w\.model\), 'xs', 'cpu'\)/);
  assert.match(source, /fusion:true, fzModel: e\.model \|\| null, text: esc\(fzWorkerLine\(e\)\)/);
});

test('Studio\'s image models wear their family\'s mark, never a letter, once renderer.js is loaded', () => {
  const view = readFileSync(new URL('../renderer/studio/images-view.js', import.meta.url), 'utf8');
  const bare = createContext({ esc: (s) => String(s), ic: () => '' });
  runInContext(view, bare);
  assert.match(bare.simgvLogo({ id: 'openai/gpt-image-1', name: 'GPT Image' }), /st-mlogo[^>]*>G</, 'without renderer.js: the old letter');

  const ctx = createContext({ esc: (s) => String(s), ic: (n) => '<i:' + n + '>',
    modelLogoKey: H.modelLogoKey, providerLogoKey: H.providerLogoKey, logoHTML: H.logoHTML, markFallbackHTML: H.markFallbackHTML });
  runInContext(view, ctx);
  assert.equal(img(ctx.simgvLogo({ id: 'openai/gpt-image-1', name: 'GPT Image 1' })), 'openai.svg');
  assert.equal(img(ctx.simgvLogo({ id: 'google/gemini-2.5-flash-image', name: 'Nano Banana' })), 'gemini-color.svg');
  assert.equal(img(ctx.simgvLogo({ id: 'qwen/qwen-image', name: 'Qwen Image' })), 'qwen-color.svg');
  assert.equal(img(ctx.simgvLogo({ id: 'x-ai/grok-2-image', name: 'Grok 2 Image' })), 'xai.svg');
  assert.equal(img(ctx.simgvLogo({ id: 'z-ai/glm-image', name: 'GLM Image' })), 'zhipu-color.svg');
  assert.equal(img(ctx.simgvLogo({ id: 'openrouter/some-image', name: 'Some image' })), 'openrouter.svg');
  // ATO-1634: FLUX now wears Black Forest Labs; a maker with no mark still gets the badge.
  assert.equal(img(ctx.simgvLogo({ id: 'black-forest-labs/flux-1', name: 'FLUX.1', group: 'cloud' })), 'bfl.svg');
  const none = ctx.simgvLogo({ id: 'kwaivgi/kling-image', name: 'Kling Image', group: 'cloud' });
  assert.doesNotMatch(none, /st-mlogo/);
  assert.match(none, /tk-ico--mark/);
  assert.equal(img(ctx.simgvLogo({ id: 'sdxl-turbo', name: 'SDXL Turbo', group: 'local' })), 'stability-color.svg');
  assert.match(ctx.simgvLogo({ id: 'tiny-sd', name: 'Tiny SD', group: 'local' }), /<i:cpu>/);
});

test('the fit test marks the judge, the local apps and each model, and keeps its words', () => {
  const R = require('../renderer/fit-test.js');
  const esc = (s) => String(s);
  const plain = { esc, ic: () => '' };
  const marked = { ...plain, mark: (id, size) => H.logoHTML(H.providerLogoKey(id), size, 'server'), modelMark: (id, size) => H.modelMark(id, size) };
  const ctx = { nameOf: (m) => String(m && m.id), judgeWord: (id) => ({ ollama: 'Ollama' })[id] || id, currentId: null };
  const judges = [{ id: 'ollama', model: 'qwen3:8b', local: true }];
  const none = R.fitEntryHTML({ supported: true, phase: 'idle', judges: [], judge: null }, 3, ctx, marked);
  assert.match(none, /ollama\.svg[\s\S]*Ollama or [\s\S]*lmstudio\.svg[\s\S]*LM Studio under Custom/);
  assert.match(R.fitEntryHTML({ supported: true, phase: 'idle', judges: [], judge: null }, 3, ctx, plain), /an app like Ollama or LM Studio under Custom/);
  assert.match(R.fitEntryHTML({ supported: true, phase: 'idle', judges, judge: 'ollama' }, 3, ctx, marked), /fit-mark"><span class="logo logo--xs"[^>]*><img src="logos\/ollama\.svg"/);
});

test('the GitHub and Stripe webhook presets wear their marks, the others do not', () => {
  const W = require('../renderer/webhooks.js');
  const st = {
    supported: true, error: null, created: null, confirm: null, busy: new Set(), creating: false, formError: null,
    data: { webhooks: [{ name: 'gh', path: '/api/webhooks/gh', verify: 'github', hasSecret: true, live: true },
      { name: 'pay', path: '/api/webhooks/pay', verify: 'stripe', hasSecret: true, live: true }], tunnel: null, tasksEnabled: true, presets: null },
    form: { verify: 'github', name: '', secret: '', template: '' },
  };
  const esc = (s) => String(s);
  const html = W.webhooksHTML(st, { esc, logo: H.logoHTML });
  assert.match(html, /data-act="whk:preset:github"><span class="logo logo--xs"><img src="logos\/github\.svg"/);
  assert.match(html, /data-act="whk:preset:stripe"><span class="logo logo--xs"><img src="logos\/stripe\.svg"/);
  assert.match(html, /data-act="whk:preset:secret">Shared secret</);
  assert.match(html, /data-whk="gh"><span class="logo logo--sm"><img src="logos\/github\.svg"/);
  assert.match(html, /data-whk="pay"><span class="logo logo--sm"><img src="logos\/stripe\.svg"/);
  assert.doesNotMatch(W.webhooksHTML(st, { esc }), /logos\//, 'no logo dep: no marks');
});

test('Composio\'s GitHub mention and the plugins pane wear their marks', () => {
  const C = require('../renderer/composio.js');
  const esc = (s) => String(s);
  const st = { hasKey: false, enabled: true, toolsUp: false, restartOwed: false, checkError: null, mode: 'list', busy: null,
    keyError: null, message: null, warning: null, lastError: null, shadowed: false, running: false };
  const withLogo = C.composioPaneHTML(st, { esc, ic: () => '', logo: H.logoHTML });
  assert.match(withLogo, /Linear and <span class="sd-inlmark"><span class="logo logo--xs"><img src="logos\/github\.svg" alt=""><\/span><\/span>GitHub,/);
  assert.match(C.composioPaneHTML(st, { esc, ic: () => '' }), /Notion, Linear and GitHub, and handles/);

  const P = require('../renderer/plugins-pane.js');
  assert.deepEqual(P.plgLogoKeys({ format: 'claude', sourceLabel: 'folder /x' }), ['claudecode']);
  assert.deepEqual(P.plgLogoKeys({ format: 'codex', sourceLabel: 'git https://github.com/a/b' }), ['codex', 'github']);
  assert.deepEqual(P.plgLogoKeys({ format: 'cursor', sourceLabel: 'marketplace local' }), ['cursor']);
  assert.deepEqual(P.plgLogoKeys({ format: null, sourceLabel: 'git git@github.com:a/b.git' }), ['github']);
});
