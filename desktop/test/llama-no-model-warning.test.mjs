// ATO-2012: a llama.cpp address that passes /health with no model in the
// server (a router started without -m) is accepted with a warning that says
// so, on the first-run URL step and in Settings › Models.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const M = require('../out/main/llama-models-probe.js');
const W = require('../renderer/llama-model-warning.js');

const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('an empty model list is "no models"; a list with a model is nothing', () => {
  assert.deepEqual(M.readLlamaModelsAnswer(200, '{"object":"list","data":[]}'), { noModels: true });
  assert.deepEqual(M.readLlamaModelsAnswer(200, '{"object":"list","data":[{"id":"qwen3-8b"}]}'), {});
});

test('503 "Loading model" is "loading"; another 503 is nothing', () => {
  assert.deepEqual(M.readLlamaModelsAnswer(503, '{"error":{"message":"Loading model","type":"unavailable_error","code":503}}'), { loading: true });
  assert.deepEqual(M.readLlamaModelsAnswer(503, 'Loading model'), { loading: true });
  assert.deepEqual(M.readLlamaModelsAnswer(503, '{"error":{"message":"server busy"}}'), {});
});

test('anything the second ask cannot read adds no flag', () => {
  assert.deepEqual(M.readLlamaModelsAnswer(404, '{"error":"not found"}'), {});
  assert.deepEqual(M.readLlamaModelsAnswer(401, ''), {});
  assert.deepEqual(M.readLlamaModelsAnswer(200, 'not json'), {});
  assert.deepEqual(M.readLlamaModelsAnswer(200, '{"models":[]}'), {});
  assert.deepEqual(M.readLlamaModelsAnswer(200, 'null'), {});
});

test('askLlamaModels sends the probe headers and never throws', async () => {
  let seen = null;
  const ok = async (url, init) => { seen = { url, init }; return { status: 200, text: async () => '{"data":[]}' }; };
  assert.deepEqual(await M.askLlamaModels('http://127.0.0.1:8080/v1/models', { authorization: 'Bearer k' }, 50, ok), { noModels: true });
  assert.equal(seen.url, 'http://127.0.0.1:8080/v1/models');
  assert.equal(seen.init.headers.authorization, 'Bearer k');
  const refused = async () => { throw new Error('ECONNREFUSED'); };
  assert.deepEqual(await M.askLlamaModels('http://127.0.0.1:8080/v1/models', {}, 50, refused), {});
  const badBody = async () => ({ status: 200, text: async () => { throw new Error('reset'); } });
  assert.deepEqual(await M.askLlamaModels('http://127.0.0.1:8080/v1/models', {}, 50, badBody), {});
});

test('the warning names the host and says what to do; none for a server with a model', () => {
  const url = 'http://127.0.0.1:8080';
  assert.equal(W.llamaModelWarning({ reachable: true, noModels: true }, url),
    '127.0.0.1:8080 has no model loaded. Load a model into the server; the agent will use it once it is loaded.');
  assert.equal(W.llamaModelWarning({ reachable: true, loading: true }, url),
    '127.0.0.1:8080 is still loading its model. You can continue; it will answer once the model is loaded.');
  assert.equal(W.llamaModelWarning({ reachable: true }, url), null);
  assert.equal(W.llamaModelWarning({ reachable: false, noModels: true }, url), null);
  assert.equal(W.llamaModelWarning(null, url), null);
});

test('no long dash in the new text', () => {
  const text = [W.llamaModelWarning({ reachable: true, noModels: true }, 'http://h:1'),
    W.llamaModelWarning({ reachable: true, loading: true }, 'http://h:1'), W.LLAMA_WARN_CONTINUE].join(' ');
  assert.ok(!text.includes('—'), text);
});

test('the second Enter on the same address and step goes on; a new address is warned again', () => {
  const seen = { step: 'custom_chat_url', url: 'http://127.0.0.1:8080' };
  assert.equal(W.llamaWarnAcknowledged(seen, 'custom_chat_url', 'http://127.0.0.1:8080'), true);
  assert.equal(W.llamaWarnAcknowledged(seen, 'custom_chat_url', 'http://127.0.0.1:8081'), false);
  assert.equal(W.llamaWarnAcknowledged(seen, 'custom_embedding_url', 'http://127.0.0.1:8080'), false);
  assert.equal(W.llamaWarnAcknowledged(null, 'custom_chat_url', 'http://127.0.0.1:8080'), false);
});

test('wiring: llamaProbe asks /v1/models after a passing /health, only to add a flag', () => {
  const cli = src('../main/agent-cli.ts');
  const start = cli.indexOf('export async function llamaProbe(');
  assert.ok(start >= 0);
  const body = cli.slice(start, cli.indexOf('\n}\n', start));
  assert.match(body, /if \(result\.reachable\) Object\.assign\(result, await askLlamaModels\(llamaEndpointUrl\(url, "\/v1\/models"\), headers\)\);/);
  assert.match(cli, /import \{ askLlamaModels \} from "\.\/llama-models-probe\.js";/);
});

test('wiring: the first-run URL step and Settings › Models show the warning', () => {
  const r = src('../renderer/renderer.js');
  const submit = r.slice(r.indexOf('async function obUrlSubmit('), r.indexOf('async function obWriteCustomEndpoint('));
  assert.match(submit, /llamaModelWarning\(probe, res\.url \|\| value\)/);
  assert.match(submit, /llamaWarnAcknowledged\(OB\.urlWarned, from, value\)/);
  const html = r.slice(r.indexOf('function obUrlHTML('), r.indexOf('function obDownloadHTML('));
  assert.match(html, /ob-warn ob-note is-amber[\s\S]*OB\.urlWarned\.text \+ ' ' \+ LLAMA_WARN_CONTINUE/);
  const save = r.slice(r.indexOf('async function llmExternalSave('), r.indexOf('async function llmFallbackPersist('));
  assert.match(save, /const noModel = llamaModelWarning\(p, res\.url\);/);
  assert.equal((save.match(/\(noModel \? '\. ' \+ noModel : ''\)/g) || []).length, 2);
  assert.match(src('../renderer/index.html'), /<script src="llama-model-warning\.js"><\/script>[\s\S]*<script src="renderer\.js"><\/script>/);
});
