// ATO-1418: Settings › Models groups like the first-run wizard (ATO-816,
// Nadya's decision 12.11: Local / Cloud / Custom). Atomic Chat, Ollama,
// LM Studio and any server on this computer are on the Custom tab, never
// under Cloud providers; keys and subscriptions stay on Cloud.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const renderer = readFileSync(new URL('../renderer/renderer.js', import.meta.url), 'utf8');
function slice(start, end) {
  const i = renderer.indexOf(start);
  assert.ok(i >= 0, start);
  const j = renderer.indexOf(end, i);
  assert.ok(j > i, end);
  return renderer.slice(i, j);
}

function grouping(providers, mode = 'cloud') {
  const ctx = createContext({ LLMP: { mode } });
  runInContext('const PROVIDERS = ' + JSON.stringify(providers) + '; function llmProviders() { return PROVIDERS; }\n'
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
];

test('apps on this computer are on Custom, keys and subscriptions on Cloud', () => {
  const g = grouping(saved);
  assert.deepEqual(g.tab('external').map((p) => p.id), ['ollama', 'lmstudio', 'atomic-chat', 'my-vllm']);
  assert.deepEqual(g.tab('cloud').map((p) => p.id), ['openrouter', 'claude-cli', 'groq', 'office-box']);
  assert.equal(g.of(saved[5]), 'external');
  assert.equal(g.of(saved[1]), 'cloud');
});

test('the built-in llama.cpp entry is on neither provider list', () => {
  const g = grouping(saved);
  for (const t of ['cloud', 'external']) assert.ok(!g.tab(t).some((p) => p.id === 'local-llama'), t);
});

test('the model block and filter follow the tab on screen', () => {
  assert.equal(grouping(saved, 'external').now(), 'external');
  assert.equal(grouping(saved, 'cloud').now(), 'cloud');
  assert.equal(grouping(saved, 'local').now(), 'cloud');
});

test('the tabs read Local models, Cloud providers, Custom; the Custom pane names the apps', () => {
  assert.match(renderer, /const LLM_BAR_MODES = \[\['local', 'Local models'\], \['cloud', 'Cloud providers'\], \['external', 'Custom'\]\];/);
  const ext = slice('function llmExternalHTML()', '/* Gaps 11:');
  assert.match(ext, /'Apps you already run'/);
  assert.match(ext, /Atomic Chat, Ollama, LM Studio or any server you run yourself/);
  assert.match(ext, /'Your own llama\.cpp server'/);
  assert.doesNotMatch(ext, /[Cc]loud/);
});
