// ATO-830: Nano Banana's OpenRouter upstream answers 429 often. Studio says so
// in plain words and offers Retry and another cloud model, not only Close.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createContext, runInContext } from 'node:vm';
const req = createRequire(import.meta.url);
const L = req('../renderer/studio/images-logic.js');
const V = req('../renderer/studio/images-view.js');

const m = (id, name, modes = ['create', 'edit'], group = 'cloud', provider = 'openrouter') => ({id, name, modes, group, provider});
const banana = m('google/nano-banana-2.1', 'Nano Banana 2.1');
const flare = m('openai/gpt-image-2.5-flare', 'GPT Image 2.5 Flare');
const flux = m('black-forest-labs/flux', 'Flux', ['create']);
const local = m('z-image:q8', 'Z-Image Turbo', ['create', 'edit'], 'local', 'local');

test('a 429 is recognised by its code and by Core’s own words on a failed job', () => {
  assert.ok(V.simgRateLimited({code: 'REMOTE_RATE_LIMITED', message: 'OpenRouter is rate limiting requests. Try again in a minute.'}));
  assert.ok(V.simgRateLimited({code: 'FAILED', message: 'openrouter is rate-limiting requests.'}));
  assert.ok(V.simgRateLimited({code: 'INTERNAL', message: 'upstream answered 429'}));
  assert.ok(!V.simgRateLimited({code: 'REMOTE_QUOTA', message: 'out of credits'}));
  assert.ok(!V.simgRateLimited(null));
});

test('the other model is never the one that failed, runs the mode, and is GPT Image first', () => {
  assert.equal(V.simgAltModel([banana, flux, flare, local], {id: banana.id, provider: 'openrouter'}, 'create').id, flare.id);
  assert.equal(V.simgAltModel([banana, flux, local], {id: banana.id}, 'create').id, flux.id);
  assert.equal(V.simgAltModel([banana, flux, local], {id: banana.id}, 'edit'), null, 'Flux cannot edit, and a local model is not offered here');
  assert.equal(V.simgAltModel([flare], {id: flare.id}, 'create'), null);
});

test('the card names the model, says nothing was charged, and carries no em dash', () => {
  const line = V.simgRateLimitLine('Nano Banana 2.1');
  assert.match(line, /provider for Nano Banana 2\.1 is busy right now/);
  assert.match(line, /Nothing was charged/);
  assert.doesNotMatch(line, /—/);
});

test('the rate-limit card offers Retry, the other model and Close', () => {
  const src = readFileSync(new URL('../renderer/studio/images-view.js', import.meta.url), 'utf8');
  const ctx = createContext({esc: (s) => String(s), ic: () => '', module: undefined});
  runInContext(src + ';this.err = simgvError;', ctx);
  ctx.simgModels = L.simgModels;
  const catalog = {cloud: {models: [banana, flare]}, local: {models: [local]}};
  const html = ctx.err({jobErr: {code: 'FAILED', message: 'openrouter is rate-limiting requests.'}, lastReq: {model: banana.id, provider: 'openrouter'},
    catalog, form: {mode: 'create'}, job: null});
  assert.match(html, /Nano Banana 2\.1 is busy/);
  assert.match(html, /studio:images:retry"[^>]*>Retry/);
  assert.match(html, /studio:images:trymodel:openrouter\|openai\/gpt-image-2\.5-flare"[^>]*>Try GPT Image 2\.5 Flare/);
  assert.match(html, /studio:images:dismiss/);
  const other = ctx.err({jobErr: {code: 'REMOTE_QUOTA', message: 'out of credits'}, catalog, form: {mode: 'create'}});
  assert.match(other, /That did not work/);
  assert.doesNotMatch(other, /trymodel/);
});

test('Try <model> switches to it and generates again', () => {
  const src = readFileSync(new URL('../renderer/studio/images.js', import.meta.url), 'utf8');
  const line = src.split('\n').find((l) => l.includes("case 'trymodel'"));
  assert.ok(line);
  assert.match(line, /chooseModel\(m\).*generate\(\)/);
});
