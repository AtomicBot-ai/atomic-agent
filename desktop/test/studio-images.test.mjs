import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
const L = req('../renderer/studio/images-logic.js');
const { simgJobOf } = req('../renderer/studio/images-view.js');

const cloudModel = (o = {}) => Object.assign({
  id: 'google/nano-banana', name: 'Nano Banana', description: null, provider: 'openrouter', kind: 'image', source: 'catalog', default: true,
  modes: ['create', 'edit', 'reference'], aspectRatios: {values: ['1:1', '16:9', '9:16'], default: '1:1'},
  resolutions: {values: ['1K', '2K'], default: '1K'}, sizes: null, durations: null, audio: false, lastFrame: false,
  seed: false, negativePrompt: false, maxCount: 4, maxInputImages: 3, quality: null, background: null, outputFormat: null,
  steps: null, cfg: null, guidance: null, strength: null, license: null, nonCommercial: null, adult: null, local: null,
}, o);
const localModel = (o = {}) => Object.assign(cloudModel({
  id: 'z-image:q8', name: 'Z-Image Turbo', provider: 'local', source: 'local', default: false,
  modes: ['create', 'transform', 'inpaint', 'extend', 'upscale'], aspectRatios: null, resolutions: null,
  sizes: {kind: 'range', min: 256, max: 2048, multiple: 64, defaultWidth: 1024, defaultHeight: 1024},
  seed: true, negativePrompt: true, maxCount: 8, maxInputImages: 1,
  steps: {min: 1, max: 50, default: 8, step: 1}, cfg: {min: 0, max: 10, default: 1, step: 0.5}, strength: {min: 0, max: 1, default: 0.6, step: 0.05},
  local: {family: 'z-image', developer: 'Tongyi', loaded: true},
}), o);
const catalog = (cloud = [cloudModel()], local = [localModel()]) => ({
  cloud: {provider: 'openrouter', kind: 'image', models: cloud, live: true, error: null, keyMissing: false},
  local: {provider: 'local', kind: 'image', models: local, live: false, error: null},
});
const form = (o = {}) => Object.assign({prompt: 'a fox', mode: 'create', aspect: '1:1', resolution: '1K', size: '', count: 1,
  negative: '', steps: null, cfg: null, guidance: null, strength: null, seed: '', seedLocked: false, source: null, mask: null, refs: []}, o);
const model = (cat, id) => L.simgFindModel(cat, id);

/* ---------- mode availability ---------- */

test('a cloud model greys the modes only local models run, with that reason', () => {
  const cat = catalog();
  const tabs = L.simgModeTabs(model(cat, 'google/nano-banana'), cat);
  const by = Object.fromEntries(tabs.map((t) => [t.id, t]));
  assert.equal(by.create.ok, true);
  assert.equal(by.edit.ok, true);
  assert.equal(by.transform.ok, false);
  assert.equal(by.transform.why, 'Needs a model on this Mac');
  assert.equal(L.simgModeNote(tabs), 'Transform, Inpaint, Extend and Upscale need a model on this Mac.');
});

test('a mode no model in the catalog runs says the chosen model cannot do it', () => {
  const cat = catalog();
  const tabs = L.simgModeTabs(model(cat, 'z-image:q8'), cat);
  const edit = tabs.find((t) => t.id === 'edit');
  assert.equal(edit.ok, false);
  assert.equal(edit.why, 'Z-Image Turbo cannot do this');
});

test('the hint line also names the modes the chosen model cannot do (ATO-832)', () => {
  const cat = catalog([cloudModel({name: 'Nano Banana 2.1'})], [localModel({modes: ['create', 'transform']})]);
  const m = model(cat, 'google/nano-banana');
  const tabs = L.simgModeTabs(m, cat);
  assert.equal(L.simgModeNote(tabs, m), 'Transform needs a model on this Mac. Nano Banana 2.1 cannot inpaint, extend or upscale.');
  assert.equal(L.simgModeNote(L.simgModeTabs(model(catalog(), 'google/nano-banana'), catalog()), m), 'Transform, Inpaint, Extend and Upscale need a model on this Mac.');
});

test('a click on a greyed mode gets its own reason, and a link only when another model can (ATO-832)', () => {
  const cat = catalog([cloudModel({name: 'Nano Banana 2.1'})], [localModel({modes: ['create', 'transform']})]);
  const m = model(cat, 'google/nano-banana');
  const by = Object.fromEntries(L.simgModeTabs(m, cat).map((t) => [t.id, t]));
  assert.equal(L.simgModeWhy(by.inpaint, m), 'Nano Banana 2.1 cannot inpaint.');
  assert.equal(L.simgModeWhy(by.transform, m), 'Transform needs a model on this Mac.');
  assert.equal(L.simgModeWhy(by.create, m), '');
  assert.equal(L.simgOtherCan(cat, m, ['inpaint']), false);
  assert.equal(L.simgOtherCan(cat, m, ['transform']), true);
  assert.equal(L.simgOtherCan(catalog(), m, ['inpaint']), true);
});

test('a greyed mode chip still acts (to show why) and says so in the hint line (ATO-832)', () => {
  const view = readFileSync(new URL('../renderer/studio/images-view.js', import.meta.url), 'utf8');
  assert.match(view, /'modewhy:'/);
  const js = readFileSync(new URL('../renderer/studio/images.js', import.meta.url), 'utf8');
  assert.match(js, /case 'modewhy': IM\.modeWhy = a;/);
});

test('with no model only Create is open', () => {
  const tabs = L.simgModeTabs(null, null);
  assert.deepEqual(tabs.filter((t) => t.ok).map((t) => t.id), ['create']);
});

test('the default model is the cloud default, else a loaded local one', () => {
  assert.equal(L.simgDefaultModel(catalog()).id, 'google/nano-banana');
  assert.equal(L.simgDefaultModel(catalog([], [localModel({local: {loaded: false}}), localModel({id: 'b', local: {loaded: true}})])).id, 'b');
  assert.equal(L.simgDefaultModel(null), null);
});

/* ---------- form → request ---------- */

test('a cloud create request carries ratio, resolution and count, and nothing the model has no control for', () => {
  const cat = catalog();
  const m = model(cat, 'google/nano-banana');
  const r = L.simgBuildRequest(form({count: 3, aspect: '16:9', resolution: '2K', negative: 'blur', seed: '42', seedLocked: true, steps: 20}), m);
  assert.equal(r.ok, true);
  assert.deepEqual(r.req, {provider: 'openrouter', model: 'google/nano-banana', mode: 'create', prompt: 'a fox', count: 3, aspectRatio: '16:9', resolution: '2K'});
});

test('the count is held to the model maximum', () => {
  const m = cloudModel();
  assert.equal(L.simgBuildRequest(form({count: 99}), m).req.count, 4);
});

test('a local request gets width/height from the ratio, steps, cfg, a locked seed and the negative prompt', () => {
  const m = localModel();
  const r = L.simgBuildRequest(form({aspect: '16:9', negative: ' text ', seed: '7', seedLocked: true, steps: 12, cfg: 2}), m);
  assert.equal(r.ok, true);
  assert.equal(r.req.provider, 'local');
  assert.equal(r.req.width % 64, 0);
  assert.ok(r.req.width > r.req.height);
  assert.equal(r.req.steps, 12);
  assert.equal(r.req.cfgScale, 2);
  assert.equal(r.req.seed, 7);
  assert.equal(r.req.negativePrompt, 'text');
});

test('an unlocked seed is not sent (the model picks one)', () => {
  assert.equal('seed' in L.simgBuildRequest(form({seed: '7', seedLocked: false}), localModel()).req, false);
});

test('edit needs a source; a gallery file goes as {path}, a dropped one as {base64}', () => {
  const m = cloudModel();
  assert.deepEqual(L.simgBuildRequest(form({mode: 'edit'}), m), {ok: false, message: 'Add a source image first.'});
  const a = L.simgBuildRequest(form({mode: 'edit', source: {path: '/x/a.png', key: '/x/a.png', name: 'a.png'}}), m);
  assert.deepEqual(a.req.initImage, {path: '/x/a.png'});
  const b = L.simgBuildRequest(form({mode: 'edit', source: {base64: 'data:image/png;base64,AA', key: 'local:1'}}), m);
  assert.deepEqual(b.req.initImage, {base64: 'data:image/png;base64,AA'});
});

test('Keep source shape sends no ratio', () => {
  const r = L.simgBuildRequest(form({mode: 'edit', aspect: 'source', source: {path: '/a.png'}}), cloudModel());
  assert.equal('aspectRatio' in r.req, false);
});

test('reference sends the source and the extra references, capped by maxInputImages', () => {
  const refs = [{path: '/1.png'}, {path: '/2.png'}, {path: '/3.png'}];
  const r = L.simgBuildRequest(form({mode: 'reference', source: {path: '/0.png'}, refs}), cloudModel());
  assert.deepEqual(r.req.initImage, {path: '/0.png'});
  assert.deepEqual(r.req.referenceImages, [{path: '/1.png'}, {path: '/2.png'}]);
});

test('inpaint needs a mask; upscale needs no prompt and sends no count', () => {
  const m = localModel();
  assert.equal(L.simgBuildRequest(form({mode: 'inpaint', source: {path: '/a.png'}}), m).ok, false);
  const ok = L.simgBuildRequest(form({mode: 'inpaint', source: {path: '/a.png'}, mask: {path: '/m.png'}}), m);
  assert.deepEqual(ok.req.maskImage, {path: '/m.png'});
  const up = L.simgBuildRequest(form({mode: 'upscale', prompt: '', source: {path: '/a.png'}}), m);
  assert.equal(up.ok, true);
  assert.equal('count' in up.req, false);
});

test('a missing prompt, a missing model and a mode the model lacks are refused with a sentence', () => {
  assert.equal(L.simgBuildRequest(form({prompt: '  '}), cloudModel()).message, 'Write a prompt first.');
  assert.equal(L.simgBuildRequest(form(), null).message, 'Pick a model first.');
  assert.match(L.simgBuildRequest(form({mode: 'upscale'}), cloudModel()).message, /cannot do this mode/);
});

test('normalize moves a form onto a new model: mode, ratio, resolution and count it takes', () => {
  const f = L.simgNormalize(form({mode: 'transform', aspect: '4:5', resolution: '4K', count: 9}), cloudModel());
  assert.equal(f.mode, 'create');
  assert.equal(f.aspect, '1:1');
  assert.equal(f.resolution, '1K');
  assert.equal(f.count, 4);
  assert.equal(f.steps, null);
});

/* ---------- price ---------- */

test('the Generate button shows a price only when there is a number', () => {
  assert.equal(L.simgGenerateLabel(null), 'Generate');
  assert.equal(L.simgGenerateLabel({usd: null}), 'Generate');
  assert.equal(L.simgGenerateLabel({usd: 0.04, maxUsd: null, basis: 'x'}), 'Generate · ≈ $0.04');
  assert.equal(L.simgPriceLabel({usd: 0.32, maxUsd: 0.4}), '≈ $0.32–0.40');
  assert.equal(L.simgPriceLabel({usd: 0.004, maxUsd: null}), '≈ $0.004');
  assert.doesNotMatch(L.simgGenerateLabel({usd: 1.5}), /—/);
});

test('price params: none for a local model; count and resolution for a cloud one', () => {
  assert.equal(L.simgPriceParams(form(), localModel()), null);
  assert.deepEqual(L.simgPriceParams(form({count: 3, resolution: '2K'}), cloudModel()), {kind: 'image', count: 3, mode: 'create', resolution: '2K'});
});

/* ---------- progress, recipe, labels ---------- */

test('progress words: image N of M, the phase and the time left', () => {
  const p = L.simgProgress({id: 'j', kind: 'image', state: 'generating', cloud: false,
    progress: {phase: 'sampling', step: 12, totalSteps: 20, fraction: 0.44, etaSeconds: 50, batchIndex: 1, batchSize: 4, slowdown: false}});
  assert.equal(p.title, 'Making image 2 of 4');
  assert.equal(p.line, 'Drawing · step 12 of 20');
  assert.equal(p.eta, 'about 50 s left');
  assert.equal(L.simgEta(150), 'about 3 min left');
  assert.equal(L.simgEta(null), '');
});

test('a cloud job shows no step count', () => {
  const p = L.simgProgress({state: 'generating', cloud: true, progress: {phase: 'sampling', step: 3, totalSteps: 10, fraction: 0.3}});
  assert.equal(p.line, 'Drawing');
});

test('a recipe comes back as form values', () => {
  const f = L.simgRecipeToForm({prompt: 'p', model: {id: 'm', name: 'M', provider: 'openrouter'},
    recipe: {prompt: 'a fox', workflow: 'edit', seed: 5, batchSize: 2, remote: {aspectRatio: '16:9', resolution: '2K'}, target: {provider: 'openrouter', model: 'google/x'}, steps: 0, cfgScale: 0}});
  assert.equal(f.prompt, 'a fox');
  assert.equal(f.mode, 'edit');
  assert.equal(f.seed, 5);
  assert.equal(f.seedLocked, true);
  assert.equal(f.count, 2);
  assert.equal(f.aspect, '16:9');
  assert.equal(f.resolution, '2K');
  assert.equal(f.modelId, 'google/x');
  assert.equal('steps' in f, false);
  assert.deepEqual(L.simgRecipeToForm({prompt: 'x', recipe: null, model: {id: 'z:q8', provider: 'local'}}), {prompt: 'x', modelId: 'z:q8', provider: 'local'});
});

test('non-commercial and 18+ models are labelled, never dropped', () => {
  const tags = L.simgModelTags(cloudModel({nonCommercial: true, adult: true})).map((t) => t.text);
  assert.deepEqual(tags, ['Non-commercial', '18+']);
  const cat = catalog([cloudModel({adult: true})]);
  assert.equal(L.simgModels(cat).length, 2);
});

test('the model row names the maker as the maker writes it (ATO-831)', () => {
  assert.equal(L.simgModelMeta(cloudModel({id: 'openai/gpt-image-1', group: 'cloud'})), 'OpenAI · via OpenRouter');
  assert.equal(L.simgModelMeta(cloudModel({id: 'black-forest-labs/flux-1.1-pro', group: 'cloud'})), 'Black Forest Labs · via OpenRouter');
  assert.equal(L.simgMaker('bytedance'), 'ByteDance');
  assert.equal(L.simgMaker('google'), 'Google');
  assert.equal(L.simgMaker('some-new-lab'), 'Some New Lab');
});

test('each shape tile is drawn from its ratio; "auto" gets no box (ATO-831)', () => {
  const key = (r) => L.simgRatioBox(r).join('x');
  for (const [a, b] of [['1:4', '1:8'], ['2:3', '3:4'], ['3:2', '5:4'], ['16:9', '21:9']]) assert.notEqual(key(a), key(b), a + ' vs ' + b);
  assert.deepEqual(L.simgRatioBox('1:1'), [22, 22]);
  assert.equal(Math.max(...L.simgRatioBox('9:16')), 22);
  assert.equal(L.simgRatioBox('auto'), null);
});

test('the hint line link is styled as a link inside the Studio page (ATO-831)', () => {
  const css = readFileSync(new URL('../renderer/css/studio.css', import.meta.url), 'utf8');
  assert.match(css, /\.studio \.st-link\{color:var\(--accent\)/);
});

test('gallery ids group by job', () => {
  assert.equal(simgJobOf('abc-def-01'), 'abc-def');
});

test('index.html loads the Studio shell and pages before renderer.js, and lets video play', () => {
  const index = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8');
  const at = (s) => index.indexOf(s);
  const r = at('<script src="renderer.js">');
  for (const s of ['studio/shell.js', 'studio/images-logic.js', 'studio/images-view.js', 'studio/images.js', 'studio/video.js']) {
    assert.ok(at('<script src="' + s + '">') > 0 && at('<script src="' + s + '">') < r, s);
  }
  assert.ok(at('studio/shell.js') < at('studio/images.js'));
  assert.match(index, /media-src 'self' file:/);
});

test('no em dash in the Images page text', () => {
  for (const f of ['../renderer/studio/images-view.js', '../renderer/studio/images.js', '../renderer/studio/images-logic.js', '../renderer/studio/shell.js']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    const strings = src.match(/'[^'\n]*'/g) || [];
    assert.equal(strings.filter((s) => s.includes('—')).length, 0, f);
  }
});
