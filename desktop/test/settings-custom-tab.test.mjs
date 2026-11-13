// ATO-1418: Settings › Models groups like the first-run wizard (ATO-816,
// Nadya's decision 12.11: Local / Cloud / Custom). Atomic Chat, Ollama,
// LM Studio and any server on this computer are on the Custom tab, never
// under Cloud providers; keys and subscriptions stay on Cloud.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const renderer = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
// ATO-1066: llmKeylessLocal asks lan-provider.js about servers on another computer.
const lan = readFileSync(new URL('../renderer/lan-provider.js', import.meta.url), 'utf8');
function slice(start, end) {
  const i = renderer.indexOf(start);
  assert.ok(i >= 0, start);
  const j = renderer.indexOf(end, i);
  assert.ok(j > i, end);
  return renderer.slice(i, j);
}

function grouping(providers, mode = 'cloud') {
  // URL: a vm context has none, and llmKeylessLocal reads hosts through it.
  const ctx = createContext({ LLMP: { mode }, URL });
  runInContext(lan + '\nconst PROVIDERS = ' + JSON.stringify(providers) + '; function llmProviders() { return PROVIDERS; }\n'
    + slice('const PRESETS = [', '\nPRESETS.filter(')
    + slice('function llmCloudProviders()', 'function llmActiveTextId()')
    + slice('function llmKeylessLocal(p)', 'function llmKeysKnown()')
    + ';this.tab = llmTabProviders; this.of = llmProviderTab; this.now = llmProvTabNow;', ctx);
  return ctx;
}

const saved = [
  { id: 'local-llama', kind: 'llama-server' },
  { id: 'openrouter', kind: 'openrouter' },
  { id: 'claude-cli', kind: 'subscription-cli' },
  { id: 'groq', kind: 'openai-compatible', baseUrl: 'https://api.groq.com/openai' },
  { id: 'ollama', kind: 'openai-compatible', baseUrl: 'http://localhost:11434' },
  { id: 'lmstudio', kind: 'openai-compatible', baseUrl: 'http://localhost:1234' },
  { id: 'atomic-chat', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1337' },
  { id: 'my-vllm', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:8000' },
  { id: 'office-box', kind: 'openai-compatible', baseUrl: 'https://llm.example.com' },
  { id: 'my-groq', kind: 'openai-compatible', baseUrl: 'https://api.groq.com/openai/v1' },
  { id: 'qwen', kind: 'qwen-openai-compatible', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
];

test('apps and any address you typed are on Custom, keys, subscriptions and cloud presets on Cloud', () => {
  const g = grouping(saved);
  // ATO-816 (Nadya): Custom is any app or server you already run, a remote OpenAI-compatible URL included,
  // the same rule as the onboarding wizard's "custom base URL" row (#1189).
  assert.deepEqual(Array.from(g.tab('external'), (p) => p.id), ['ollama', 'lmstudio', 'atomic-chat', 'my-vllm', 'office-box']);
  // A cloud preset is openai-compatible too: told apart by its id or its preset's host.
  assert.deepEqual(Array.from(g.tab('cloud'), (p) => p.id), ['openrouter', 'claude-cli', 'groq', 'my-groq', 'qwen']);
  assert.equal(g.of(saved[5]), 'external');
  assert.equal(g.of(saved[1]), 'cloud');
});

test('Azure OpenAI and Bedrock added in the terminal, and W&B, sit on Cloud; Lemonade on Custom', () => {
  // ATO-468 / ATO-931 / ATO-626: per-account hosts match their preset by host pattern.
  const g = grouping([
    { id: 'azure-openai', kind: 'openai-compatible', baseUrl: 'https://my-team.openai.azure.com/openai' },
    { id: 'bedrock', kind: 'openai-compatible', baseUrl: 'https://bedrock-mantle.eu-west-1.api.aws' },
    { id: 'wandb', kind: 'openai-compatible', baseUrl: 'https://api.inference.wandb.ai' },
    { id: 'lemonade', kind: 'openai-compatible', baseUrl: 'http://localhost:13305' },
    { id: 'lookalike', kind: 'openai-compatible', baseUrl: 'https://openai.azure.com.example.com' },
  ]);
  assert.deepEqual(Array.from(g.tab('cloud'), (p) => p.id), ['azure-openai', 'bedrock', 'wandb']);
  assert.deepEqual(Array.from(g.tab('external'), (p) => p.id), ['lemonade', 'lookalike']);
});

test('the built-in llama.cpp entry is on neither provider list', () => {
  const g = grouping(saved);
  for (const t of ['cloud', 'external']) assert.ok(!g.tab(t).some((p) => p.id === 'local-llama'), t);
});

test('the model block and filter follow the setup on screen', () => {
  assert.equal(grouping(saved, 'external').now(), 'external');
  assert.equal(grouping(saved, 'cloud').now(), 'cloud');
  assert.equal(grouping(saved, 'fallback').now(), 'cloud');
  // 13.11: the Local card's setup lists the apps you run under the local models, so their models block is the one it shows.
  assert.equal(grouping(saved, 'local').now(), 'external');
});

test('no Set up models tabs; the Local setup names the apps you already run, in one place', () => {
  assert.doesNotMatch(renderer, /const LLM_BAR_MODES =/);
  assert.doesNotMatch(renderer, /class="llmmode|llm-srcbar|'Set up models'/);
  const local = slice('function llmLocalHTML()', '\n}\n');
  assert.match(local, /llmAppsHTML\(\)/);
  // The apps are added in the apps section only, not from the Local models header too.
  assert.doesNotMatch(local, /llm:ollama|llm:app:/);
  const apps = slice('function llmAppsHTML()', 'function llmCloudHTML()');
  // The section heading is markup now (llm-sh-t), not a bare string argument.
  assert.match(apps, /<span class="llm-sh-t">Use an app you already run<\/span>/);
  assert.match(apps, /'Add Ollama'/);
  assert.match(apps, /'Add your own server'/);
  // The list and its Add app, or the Add buttons: never both.
  assert.match(apps, /listed\.length \? listHTML/);
  // No word "cloud" in what the apps section says; its code may name the shared llmCloud* helpers and row kinds.
  // Comments out first: an apostrophe in one ("the wizard's") would pair the quotes wrongly.
  const code = apps.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const words = (code.match(/'[^']*'/g) || []).filter((w) => !/^'cloud[A-Z]/.test(w)).join(' ');
  assert.doesNotMatch(words, /cloud/i);
});

// Review round: with only Ollama saved, the Cloud choice is blocked ("add a cloud provider"),
// since an app is not a cloud provider; through llmRouteNeeds itself.
test('an app alone does not count as a cloud provider for the Cloud choice', () => {
  const ctx = createContext({ LLMP: { mode: 'cloud', local: null }, BSW: { readyIds: ['ollama'], readyLoaded: true, localLoaded: false },
    SEL: { local: [] }, THIS_MACHINE: 'this Mac', fzBlocker: () => null });
  const run = (providers) => runInContext('PROVIDERS = ' + JSON.stringify(providers) + '; llmRouteNeeds();', ctx);
  runInContext('var PROVIDERS = []; function llmProviders() { return PROVIDERS; } function llmLocalModels() { return {}; }\n'
    + slice('const PRESETS = [', '\nPRESETS.filter(')
    + slice('function llmCloudProviders()', 'function llmActiveTextId()')
    + slice('function llmKeylessLocal(p)', 'function llmKeysKnown()')
    + slice('function llmRouteNeeds()', '\nfunction llmRouteNeedsOpen('), ctx);
  const onlyApp = run([{ id: 'local-llama', kind: 'llama-server' }, { id: 'ollama', kind: 'openai-compatible', baseUrl: 'http://localhost:11434' }]);
  assert.equal(onlyApp.cloud && onlyApp.cloud.line, 'Add a cloud provider first');
  ctx.BSW.readyIds = ['groq'];
  const withGroq = run([{ id: 'ollama', kind: 'openai-compatible', baseUrl: 'http://localhost:11434' }, { id: 'groq', kind: 'openai-compatible', baseUrl: 'https://api.groq.com/openai' }]);
  assert.equal(withGroq.cloud, null);
});

test('Configure opens the Cloud setup on cloud providers only; a card not ready opens its setup and switches nothing', () => {
  const needsOpen = slice('function llmRouteNeedsOpen(id)', '\n}\n');
  // 13.11: the card's own setup, with what it needs said in it; no wizard pops up on the click.
  assert.match(needsOpen, /LLMP\.pendingRoute = id;/);
  assert.match(needsOpen, /llmShowCard\(id\);/);
  assert.doesNotMatch(needsOpen, /llmOpenWizard|runmode:/);
  const configure = slice("if (verb === 'configure') {", 'llmOpenWizard(p || null); return;');
  assert.match(configure, /llmTabProviders\(tab\)/);
  assert.match(configure, /llmSetMode\(tab\)/);
});
