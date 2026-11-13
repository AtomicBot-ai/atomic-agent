// ATO-1445: an Ollama, Atomic Chat or other OpenAI-compatible address typed
// where a llama.cpp server goes. Since ATO-816 (the first-run wizard) and
// ATO-1418 (Settings › Models) those servers are added under "Custom", never
// under Cloud, and the TUI's "LLM tab › Cloud › n" path does not exist in the
// desktop. The same sentence reaches the wizard and Settings, so it may name
// only what both screens call "Custom".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const source = readFileSync(new URL('../main/agent-cli.ts', import.meta.url), 'utf8');
function slice(start, end) {
  const i = source.indexOf(start);
  assert.ok(i >= 0, start);
  const j = source.indexOf(end, i);
  assert.ok(j > i, end);
  return source.slice(i, j);
}
// The four functions involved, with their TypeScript signatures made plain JS.
const js = [
  slice('function looksLikeOllamaUrl(', '\n/** src/llm/describe-llama-health-failure.ts looksLikeAtomicChatUrl'),
  slice('function looksLikeAtomicChatUrl(', '\n/** src/tui/providers/is-local-provider-url.ts'),
  slice('function isLocalProviderUrl(', '\nfunction bodyLooksLikeLlamaHealth('),
  slice('function describeLlamaHealthFailure(', '\nexport async function llamaProbe('),
].join('\n')
  .replace(/\((\w+): string\): boolean/g, '($1)')
  .replace(/\(kind: [^,]+, error: string \| null, url: string\): string/, '(kind, error, url)');
const ctx = createContext({ URL });
runInContext(js + '\nthis.describe = describeLlamaHealthFailure;', ctx);
const hint = (url) => ctx.describe('openai-compat', null, url);

test('no hint points at Cloud or the TUI path', () => {
  for (const url of ['http://127.0.0.1:11434', 'http://192.168.1.50:11434', 'http://127.0.0.1:1337', 'http://127.0.0.1:1234', 'http://192.168.1.50:1337']) {
    const line = hint(url);
    assert.doesNotMatch(line, /cloud provider/i, line);
    assert.doesNotMatch(line, /Cloud ›|LLM tab/, line);
    assert.match(line, /under Custom/, line);
    assert.ok(line.includes('base URL ' + url), line);
  }
});

test('Ollama on this computer is named as the Ollama app', () => {
  assert.match(hint('http://127.0.0.1:11434'), /answers like Ollama .*Add it as Ollama under Custom instead/);
});

test('Ollama on another machine goes in as an OpenAI-compatible API', () => {
  const line = hint('http://192.168.1.50:11434');
  assert.match(line, /Add it under Custom as an OpenAI-compatible API instead/);
  assert.match(line, /any API key value passes/);
});

test('Atomic Chat on this computer is named as the Atomic Chat app', () => {
  assert.match(hint('http://127.0.0.1:1337'), /Atomic Chat's Local API Server.*Add it as Atomic Chat under Custom instead/);
});

test('any other OpenAI-compatible server (and Atomic Chat elsewhere) is the OpenAI-compatible row', () => {
  for (const url of ['http://127.0.0.1:1234', 'http://192.168.1.50:1337']) {
    assert.match(hint(url), /answers like an OpenAI-compatible server.*Add it under Custom as an OpenAI-compatible API instead/);
  }
});

test('the other verdicts are unchanged', () => {
  assert.match(ctx.describe('llama-loading', null, 'http://127.0.0.1:9931'), /still loading its model/);
  assert.match(ctx.describe('unknown', 'http 500', 'http://127.0.0.1:9931'), /local-llm \/health failed at http:\/\/127\.0\.0\.1:9931: http 500/);
});
