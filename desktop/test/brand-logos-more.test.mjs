// ATO-1634: the brands that still had a letter, a generic icon or plain text
// now wear their mark: Connections (Telegram, Discord, ntfy, Composio, Exa and
// the apps Composio names), the MCP catalog, more providers (W&B, Lemonade,
// llama.cpp, Azure, Bedrock, Foundry Local, Alibaba Cloud), more model
// families (Meta, Phi, BGE, Jina, Nomic), Stripe webhooks, Cursor plugins,
// Join Discord and Studio's makers. All through renderer.js's one helper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
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
function constLine(name) {
  const at = source.indexOf('\nconst ' + name + ' = ');
  assert.ok(at >= 0, name + ' is a top-level const in renderer.js');
  return source.slice(at + 1, source.indexOf('\n', at + 1) + 1);
}

const ctx = createContext({ ic: (n) => '<i:' + n + '>', esc: (s) => String(s) });
runInContext([
  constBlock('LOGO_FILES'), constBlock('PROVIDER_LOGO_KEYS'), constLine('SETTINGS_PANE_LOGOS'),
  fn('modelLogoKey'), fn('providerLogoKey'), fn('logoHTML'), fn('markFallbackHTML'), fn('modelMark'), fn('providerMark'),
  'this.LOGO_FILES = LOGO_FILES; this.PROVIDER_LOGO_KEYS = PROVIDER_LOGO_KEYS; this.SETTINGS_PANE_LOGOS = SETTINGS_PANE_LOGOS;',
].join('\n'), ctx);
const H = ctx;
const img = (html) => (String(html).match(/src="logos\/([^"]+)"/) || [])[1] || '';
const esc = (s) => String(s);

test('every LOGO_FILES entry is a file in renderer/logos/', () => {
  for (const [key, file] of Object.entries(H.LOGO_FILES)) {
    assert.ok(existsSync(new URL('../renderer/logos/' + file, import.meta.url)), key + ' -> ' + file);
  }
  // Every key the maps point at has a file.
  for (const k of new Set(Object.values(H.PROVIDER_LOGO_KEYS))) assert.ok(H.LOGO_FILES[k], 'provider key ' + k);
  for (const k of Object.values(H.SETTINGS_PANE_LOGOS)) assert.ok(H.LOGO_FILES[k], 'pane key ' + k);
  const { MCP_CATALOG_LOGOS } = require('../renderer/mcp-catalog.js');
  for (const k of Object.values(MCP_CATALOG_LOGOS)) assert.ok(H.LOGO_FILES[k], 'catalog key ' + k);
});

test('providers that had the server icon wear their own mark; a custom endpoint keeps the server', () => {
  assert.equal(img(H.providerMark('wandb')), 'wandb-color.svg');
  assert.equal(img(H.providerMark('W&B Inference (CoreWeave)')), 'wandb-color.svg');
  assert.equal(img(H.providerMark('lemonade')), 'lemonade.png');
  assert.equal(img(H.providerMark('llamacpp-server')), 'llamacpp.png');
  assert.equal(img(H.providerMark('llama-server')), 'llamacpp.png');
  assert.equal(img(H.providerMark('azure-openai')), 'azure-color.svg');
  assert.equal(img(H.providerMark('bedrock')), 'bedrock-color.svg');
  assert.equal(img(H.providerMark('foundry-local')), 'microsoft-color.svg');
  assert.equal(img(H.providerMark('dashscope')), 'alibabacloud-color.svg');
  assert.equal(img(H.providerMark('DashScope (Qwen)')), 'alibabacloud-color.svg');
  assert.match(H.providerMark(''), /<i:server>/);
  assert.match(H.providerMark('my-endpoint'), /<i:server>/);
  // Ones that already had a mark keep it.
  assert.equal(img(H.providerMark('openrouter')), 'openrouter.svg');
  assert.equal(img(H.providerMark('ollama')), 'ollama.svg');
});

test('more model families wear a mark; look-alike words do not', () => {
  const k = (id) => H.modelLogoKey(id);
  assert.equal(k('meta-llama/llama-3.3-70b-instruct'), 'meta');
  assert.equal(k('llama3.2:3b'), 'meta');
  assert.equal(k('codellama-13b'), 'meta');
  assert.equal(k('muse-spark'), 'meta');
  assert.equal(k('phi-4-mini'), 'microsoft');
  assert.equal(k('microsoft/phi4'), 'microsoft');
  assert.equal(k('bge-m3'), 'baai');
  assert.equal(k('jina-embeddings-v3'), 'jina');
  assert.equal(k('nomic-embed-text'), 'nomic');
  assert.equal(k('black-forest-labs/flux.2-pro'), 'bfl');
  assert.equal(k('bytedance-seed/seedream-4.5'), 'bytedance');
  assert.equal(k('minimax/hailuo-02'), 'minimax');
  assert.equal(k('lightricks/ltx-2'), 'lightricks');
  assert.equal(k('wan-ai/wan2.2-t2v'), 'alibabacloud');
  // Not caught: other families and words that merely contain the letters.
  assert.equal(k('dolphin-mixtral'), '');
  assert.equal(k('tinyllama-1.1b'), '');
  assert.equal(k('swan-7b'), '');
  assert.equal(k('local-llama'), '');
  assert.equal(k('nousresearch/hermes-3-llama-3.1-405b'), 'nous');
  // Gemma keeps Google's mark (a decision of 30.09, not changed here).
  assert.equal(k('gemma-4-e4b'), 'google');
  assert.equal(k('qwen3:8b'), 'qwen');
});

test('MCP server names and Studio makers resolve through providerLogoKey', () => {
  for (const [name, key] of [['notion', 'notion'], ['playwright', 'playwright'], ['brave-search', 'brave'], ['context7', 'context7'],
    ['firecrawl', 'firecrawl'], ['apify', 'apify'], ['brightdata', 'brightdata'], ['tavily', 'tavily'], ['monid', 'monid'],
    ['exa', 'exa'], ['composio', 'composio'], ['black-forest-labs', 'bfl'], ['stabilityai', 'stability'], ['recraft', 'recraft'],
    ['ideogram', 'ideogram'], ['meta-llama', 'meta']]) {
    assert.equal(H.providerLogoKey(name), key, name);
  }
});

test('the MCP catalog cards have marks for the branded servers, letters for the basics; the data copy is untouched', () => {
  const C = require('../renderer/mcp-catalog.js');
  for (const id of ['github', 'playwright', 'context7', 'notion', 'exa', 'firecrawl', 'apify', 'brightdata', 'tavily', 'brave-search', 'monid']) {
    assert.ok(C.MCP_CATALOG_LOGOS[id], id);
    assert.ok(C.mcpCatalogEntry ? C.mcpCatalogEntry(id) : true, id + ' is in the catalog');
  }
  for (const id of ['filesystem', 'git', 'fetch', 'time', 'memory']) assert.equal(C.MCP_CATALOG_LOGOS[id], undefined, id);
  for (const e of C.MCP_CATALOG.entries) assert.equal(e.logo, undefined, 'no logo field in the data copy: ' + e.id);
  assert.match(source, /const key = e && typeof MCP_CATALOG_LOGOS !== 'undefined' \? MCP_CATALOG_LOGOS\[e\.id\] : '';/);
});

test('Connections tabs, Telegram, Discord, Phone push, Composio and Exa wear their marks', () => {
  assert.deepEqual({ ...H.SETTINGS_PANE_LOGOS }, { telegram: 'telegram', discord: 'discord', push: 'ntfy', composio: 'composio', monid: 'monid' });
  assert.match(source, /\(SETTINGS_PANE_LOGOS\[p\] \? logoHTML\(SETTINGS_PANE_LOGOS\[p\], 'xs'\) : ''\)/);
  assert.match(source, /logoHTML\('telegram', 'lg', 'send'\)/);
  assert.match(source, /logoHTML\('telegram', '', 'send'\)/);

  const D = require('../renderer/discord-settings.js');
  const dcSt = { mode: 'list', busy: null, known: true, hasToken: false, restart: { phase: 'idle' }, cfg: { ownerUserIds: [] } };
  const html = D.discordPaneHTML(dcSt, {}, { esc, ic: (n) => '<i:' + n + '>', logo: H.logoHTML });
  assert.match(html, /data-dc-connect><span class="logo logo--lg" data-fb="chat"><img src="logos\/discord\.svg"/);
  assert.match(D.discordPaneHTML(dcSt, {}, { esc, ic: (n) => '<i:' + n + '>' }), /data-dc-connect><span class="tk-ico tk-ico--lg tk-ico--blue"><i:chat>/);

  const C = require('../renderer/composio.js');
  const st = { hasKey: false, enabled: true, toolsUp: false, restartOwed: false, checkError: null, mode: 'list', busy: null,
    keyError: null, message: null, warning: null, lastError: null, shadowed: false, running: false };
  const withLogo = C.composioPaneHTML(st, { esc, ic: () => '', logo: H.logoHTML });
  for (const f of ['composio.png', 'gmail.png', 'slack.svg', 'notion.svg', 'linear.svg', 'github.svg']) assert.match(withLogo, new RegExp('logos/' + f.replace('.', '\\.')), f);
  assert.match(withLogo, /<span class="sd-inlmark"><span class="logo logo--xs"><img src="logos\/gmail\.png" alt=""><\/span><\/span>Gmail, /);
  const plain = C.composioPaneHTML(st, { esc, ic: () => '' });
  assert.match(plain, /apps like Gmail, Slack, Notion, Linear and GitHub, and handles/);
  assert.doesNotMatch(plain, /logos\//);

  const E = require('../renderer/exa-key.js');
  const exaSt = { has: false, saving: false, error: null, note: null, saved: false, restartOwed: false, busy: false };
  assert.match(E.exaKeySettingsRowHTML(exaSt, { esc, ic: () => '', logo: H.logoHTML }), /exak-row"><span class="logo logo--sm"><img src="logos\/exa-color\.svg"/);
  assert.doesNotMatch(E.exaKeySettingsRowHTML(exaSt, { esc, ic: () => '' }), /logos\//);
  assert.match(E.exaKeyCardHTML({ reason: 'missing', getKeyUrl: 'https://exa.ai' }, exaSt, { esc, ic: (n) => '<i:' + n + '>', logo: H.logoHTML }),
    /exak-head"><span class="logo logo--xs"><img src="logos\/exa-color\.svg"/);
  assert.match(E.exaKeyCardHTML({ reason: 'missing', getKeyUrl: 'https://exa.ai' }, exaSt, { esc, ic: (n) => '<i:' + n + '>' }), /exak-head"><i:search>/);
});

test('Join Discord wears Discord\'s mark in the palette and the sidebar', () => {
  assert.match(source, /\['logo:discord','Join Discord','','','help\.discord'\]/);
  assert.match(source, /\(logoHTML\('discord', 'xs', 'discord'\) \|\| ic\('discord'\)\)/);
});

test('Studio video rows wear their maker\'s mark, and nothing without renderer.js', () => {
  const v = readFileSync(new URL('../renderer/studio/video.js', import.meta.url), 'utf8');
  assert.match(v, /function vMark\(m\) \{\n\s+if \(!m \|\| typeof logoHTML !== 'function' \|\| typeof modelLogoKey !== 'function'\) return '';/);
  assert.match(v, /data-vact="model" data-v="' \+ escHtml\(m\.id\) \+ '">' \+ vMark\(m\)/);
});
