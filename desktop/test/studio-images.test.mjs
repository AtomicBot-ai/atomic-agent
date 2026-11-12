import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
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
  assert.equal(by.transform.why, 'Needs a model on this Mac. Switch the chat to local to use it');
  assert.equal(L.simgModeNote(tabs), 'Transform, Inpaint, Extend and Upscale need a model on this Mac: switch the chat to local to use them.');
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
  assert.equal(L.simgModeNote(tabs, m), 'Transform needs a model on this Mac: switch the chat to local to use it. Nano Banana 2.1 cannot inpaint, extend or upscale.');
  assert.equal(L.simgModeNote(L.simgModeTabs(model(catalog(), 'google/nano-banana'), catalog()), m), 'Transform, Inpaint, Extend and Upscale need a model on this Mac: switch the chat to local to use them.');
});

test('a click on a greyed mode gets its own reason, and a link only when another model can (ATO-832)', () => {
  const cat = catalog([cloudModel({name: 'Nano Banana 2.1'})], [localModel({modes: ['create', 'transform']})]);
  const m = model(cat, 'google/nano-banana');
  const by = Object.fromEntries(L.simgModeTabs(m, cat).map((t) => [t.id, t]));
  assert.equal(L.simgModeWhy(by.inpaint, m), 'Nano Banana 2.1 cannot inpaint.');
  assert.equal(L.simgModeWhy(by.transform, m), 'Transform needs a model on this Mac: switch the chat to local to use it.');
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

/* ---------- Pinned tab (Core lists by page only) ---------- */

const galleryOf = (n, pinnedAt) => Array.from({length: n}, (_, i) => ({id: 'job' + i + '-01', createdAtMs: 10_000 - i, pinned: pinnedAt.includes(i)}));
const pager = (all, calls) => async (offset, limit) => {
  calls.push([offset, limit]);
  const items = all.slice(offset, offset + limit);
  return {ok: true, data: {items, hasMore: offset + items.length < all.length, total: all.length}};
};

test('the Pinned tab finds pinned images in pages the window has not loaded', async () => {
  const all = galleryOf(450, [3, 120, 449]);
  const calls = [];
  const r = await L.simgFindPinned(pager(all, calls), 50);
  assert.deepEqual(r.items.map((x) => x.id), ['job120-01', 'job449-01']);
  assert.equal(r.complete, true);
  assert.equal(r.ok, true);
  assert.deepEqual(calls, [[50, 200], [250, 200]]);
});

test('reading pinned images stops at the cap and says the list may be partial', async () => {
  const all = galleryOf(100, [5, 95]);
  const calls = [];
  const r = await L.simgFindPinned(pager(all, calls), 0, {pageSize: 10, maxPages: 3});
  assert.deepEqual(r.items.map((x) => x.id), ['job5-01']);
  assert.equal(r.complete, false);
  assert.equal(calls.length, 3);
});

test('a failed page keeps the pinned images found before it', async () => {
  const all = galleryOf(30, [2, 25]);
  let n = 0;
  const r = await L.simgFindPinned(async (offset, limit) => (n++ ? {ok: false, error: {code: 'CORE', message: 'x'}} : pager(all, [])(offset, limit)), 0, {pageSize: 10});
  assert.deepEqual(r.items.map((x) => x.id), ['job2-01']);
  assert.equal(r.ok, false);
  assert.equal(r.complete, false);
  const thrown = await L.simgFindPinned(async () => { throw new Error('gone'); }, 0);
  assert.deepEqual(thrown, {items: [], complete: false, ok: false});
});

test('the Pinned list joins loaded and found items, newest first, each once, only pinned ones', () => {
  const loaded = [{id: 'a', createdAtMs: 5, pinned: true}, {id: 'b', createdAtMs: 4, pinned: false}];
  const more = [{id: 'c', createdAtMs: 1, pinned: true}, {id: 'a', createdAtMs: 5, pinned: true}, {id: 'd', createdAtMs: 3, pinned: false}];
  assert.deepEqual(L.simgPinnedList(loaded, more).map((x) => x.id), ['a', 'c']);
  assert.deepEqual(L.simgPinnedList(loaded, undefined).map((x) => x.id), ['a']);
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

test('the local model hint says what Generate does: it loads a downloaded model by itself (ATO-1303)', () => {
  const { simgvLocalHint } = req('../renderer/studio/images-view.js');
  assert.equal(simgvLocalHint({ local: { loaded: false, installed: true } }), ' · loads when you press Generate');
  assert.equal(simgvLocalHint({ local: { loaded: false, installed: false } }), ' · not downloaded yet');
  assert.equal(simgvLocalHint({ local: { loaded: true, installed: true } }), '');
  assert.equal(simgvLocalHint({ local: null }), '');
  const view = readFileSync(new URL('../renderer/studio/images-view.js', import.meta.url), 'utf8');
  assert.match(view, /runs on ' \+ esc\(simgMachine\(\)\) \+ simgvLocalHint\(model\)/);
  // \b: the old hint stays banned, while "Download the model first" (ATO-1395) passes.
  assert.doesNotMatch(view, /\bload the model first/i);
});

test('the machine is "this Mac" only on macOS; Windows and Linux say "this computer" (ATO-1400)', () => {
  const had = globalThis.atomic;
  try {
    delete globalThis.atomic;
    assert.equal(L.simgMachine(), 'this Mac');
    for (const platform of ['win32', 'linux']) {
      globalThis.atomic = {platform};
      assert.equal(L.simgMachine(), 'this computer');
      assert.equal(L.simgMachineCap(), 'This computer');
      assert.equal(L.simgModelMeta({group: 'local', local: {developer: 'Tongyi'}}), 'Tongyi · On this computer');
      const cat = catalog();
      const tabs = L.simgModeTabs(model(cat, 'google/nano-banana'), cat);
      assert.equal(tabs.find((t) => t.id === 'transform').why, 'Needs a model on this computer. Switch the chat to local to use it');
      assert.equal(L.simgModeNote(tabs), 'Transform, Inpaint, Extend and Upscale need a model on this computer: switch the chat to local to use them.');
    }
    globalThis.atomic = {platform: 'darwin'};
    assert.equal(L.simgModelMeta({group: 'local', local: {}}), 'On this Mac');
  } finally {
    if (had === undefined) delete globalThis.atomic; else globalThis.atomic = had;
  }
  for (const f of ['../renderer/studio/images-view.js', '../renderer/studio/images.js', '../renderer/studio/images-logic.js']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    const strings = (src.match(/'[^'\n]*'/g) || []).filter((x) => /this Mac|your Mac|Show in Finder/.test(x));
    assert.deepEqual(strings.filter((x) => x !== "'this Mac'" && x !== "'Mac'" && x !== "'Show in Finder'"), [], f);
  }
});

/* ---------- ATO-1394: the page re-reads the catalog after a local change ---------- */

/** images-logic.js, images-view.js and images.js in one vm context with a stub STUDIO, BR and timers. */
function loadImagesPage(cat, extra = {}) {
  const pages = {};
  const timers = [];
  let reads = 0;
  const ctx = {
    console, Promise, JSON, Object, Array, Map, Set, Math, Number, String,
    localStorage: { getItem: () => null, setItem: () => undefined },
    document: { activeElement: null, getElementById: () => null },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: (id) => { if (id) timers[id - 1] = null; },
    STUDIO: { register: (id, page) => { pages[id] = page; }, isStudioFile: () => true },
  };
  ctx.window = ctx;
  ctx.atomic = { platform: 'darwin', studio: { catalog: () => { reads++; return Promise.resolve({ ok: true, data: cat }); }, price: () => Promise.resolve({ ok: false }) } };
  Object.assign(ctx.atomic.studio, extra.studio || {});
  vm.createContext(ctx);
  for (const f of ['images-logic.js', 'images-view.js', 'images.js']) {
    vm.runInContext(readFileSync(new URL('../renderer/studio/' + f, import.meta.url), 'utf8'), ctx, { filename: f });
  }
  const flush = () => { const run = timers.splice(0); run.forEach((fn) => fn && fn()); };
  return { page: pages.images, reads: () => reads, flush };
}
const settle = () => new Promise((r) => setImmediate(r));

test('the Images page re-reads the catalog once after a model loads, and not while it is loading', async () => {
  const P = loadImagesPage(catalog());
  P.page.onShow();
  await settle();
  assert.equal(P.reads(), 1, 'first read on show');
  P.page.onLocal({ type: 'load', state: 'loading' });
  P.page.onLocal({ type: 'download', download: { id: 'z-image:q8', state: 'downloading' } });
  P.flush();
  await settle();
  assert.equal(P.reads(), 1, 'a load in progress or a running download reads nothing');
  P.page.onLocal({ type: 'load', state: 'loaded' });
  P.page.onLocal({ type: 'download', download: { id: 'z-image:q8', state: 'done' } });
  P.page.onLocal({ type: 'removed', id: 'z-image:q8' });
  P.flush();
  await settle();
  assert.equal(P.reads(), 2, 'several events in a row make one read');
});

test('the default and the remembered model come from where the chat runs (ATO-1305)', () => {
  const flux = localModel({id: 'flux', name: 'FLUX', local: {loaded: false, installed: true}});
  const cold = localModel({id: 'cold', name: 'Cold', local: {loaded: false, installed: false}});
  const cat = catalog([cloudModel({default: false, id: 'a/one'}), cloudModel()], [cold, flux, localModel()]);
  assert.equal(L.simgPlaceOf(model(cat, 'flux')), 'local');
  assert.equal(L.simgPlaceOf(model(cat, 'google/nano-banana')), 'cloud');
  assert.equal(L.simgPlaceOf(null), null);
  assert.equal(L.simgDefaultModel(cat, 'cloud').id, 'google/nano-banana');
  assert.equal(L.simgDefaultModel(cat, 'local').id, 'z-image:q8', 'a loaded model first');
  assert.equal(L.simgDefaultModel(catalog([cloudModel()], [cold, flux]), 'local').id, 'flux', 'else a downloaded one');
  assert.equal(L.simgDefaultModel(catalog([cloudModel()], [cold]), 'local'), null, 'never the cloud');
  assert.equal(L.simgDefaultModel(catalog([], [localModel()]), 'cloud'), null, 'never a local one');
  // The chat is in the cloud, FLUX was picked before (ATO-902): a cloud model.
  assert.equal(L.simgPickModel(cat, 'cloud', [{modelId: 'flux', provider: 'local'}]).id, 'google/nano-banana');
  assert.equal(L.simgPickModel(cat, 'cloud', [{modelId: 'flux', provider: 'local'}, {modelId: 'a/one', provider: 'openrouter'}]).id, 'a/one');
  assert.equal(L.simgPickModel(cat, 'local', [{modelId: 'a/one', provider: 'openrouter'}, {modelId: 'cold', provider: 'local'}]).id, 'cold');
  // Settings not read yet: the remembered one wherever it runs.
  assert.equal(L.simgPickModel(cat, null, [{modelId: 'flux', provider: 'local'}]).id, 'flux');
  assert.equal(L.simgPickModel(cat, null, [null]).id, 'google/nano-banana');
});

test('the picker and the hints keep to the place the chat runs in (ATO-1307)', () => {
  const V = req('../renderer/studio/images-view.js');
  globalThis.esc = (x) => String(x).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  globalThis.ic = () => '';
  const lent = Object.keys(L).filter((k) => !(k in globalThis));
  for (const k of lent) globalThis[k] = L[k];   // images-view.js reads images-logic.js's names as globals, as in the window
  try {
    const cat = catalog();
    const IM = (place) => ({pop: 'model', modelQ: '', catalog: cat, model: model(cat, 'google/nano-banana'), place});
    const cloudOnly = V.simgvPop(IM('cloud'));
    assert.match(cloudOnly, /Nano Banana/);
    assert.doesNotMatch(cloudOnly, /Z-Image Turbo/);
    assert.match(cloudOnly, /Studio follows your chat\. To use a model on this Mac, switch the chat to local\./);
    const localOnly = V.simgvPop(IM('local'));
    assert.match(localOnly, /Z-Image Turbo/);
    assert.doesNotMatch(localOnly, /Nano Banana/);
    assert.match(localOnly, /To use a cloud model, switch the chat to the cloud\./);
    const both = V.simgvPop(IM(null));
    assert.match(both, /Nano Banana/);
    assert.match(both, /Z-Image Turbo/);
    assert.doesNotMatch(both, /Studio follows your chat/);
  } finally { delete globalThis.esc; delete globalThis.ic; for (const k of lent) delete globalThis[k]; }
  // "Pick one" counts only the models the picker shows.
  const cat = catalog();
  const m = model(cat, 'google/nano-banana');
  assert.equal(L.simgOtherCan(cat, m, ['transform']), true);
  assert.equal(L.simgOtherCan(cat, m, ['transform'], 'cloud'), false);
  // Restore keeps the model when the picture came from the other place.
  const fromLocal = {recipe: {target: {provider: 'local', model: 'flux'}}};
  assert.equal(L.simgRestoreNote(fromLocal, 'cloud'), 'That picture was made on this Mac. Studio follows your chat, so the current model stays.');
  assert.equal(L.simgRestoreNote(fromLocal, 'local'), '');
  assert.equal(L.simgRestoreNote({model: {id: 'google/nano-banana', provider: 'openrouter'}}, 'local'), 'That picture was made in the cloud. Studio follows your chat, so the current model stays.');
  assert.equal(L.simgRestoreNote(fromLocal, null), '');
});

test('a local model that is not on disk gets a Download, not just an error (ATO-1395, ATO-1308)', () => {
  const q = (o) => Object.assign({id: 'flux:q4', quant: 'q4', label: 'Q4', bytes: 6.2e9, downloadBytes: 6.2e9, installed: false, recommended: false, fit: {verdict: 'ok'}}, o);
  const cold = localModel({id: 'flux', name: 'FLUX', local: {family: 'flux', loaded: false, installed: false, defaultQuant: 'flux:q8',
    quants: [q({id: 'flux:q4', bytes: 6e9}), q({id: 'flux:q8', bytes: 12e9, downloadBytes: 12e9}), q({id: 'flux:q2', recommended: true})]}});
  assert.equal(L.simgQuantToGet(cold).id, 'flux:q8', 'the quant the picker opens on');
  assert.equal(L.simgQuantToGet(localModel({local: {quants: [q({id: 'a', bytes: 9}), q({id: 'b', recommended: true})]}})).id, 'b');
  assert.equal(L.simgQuantToGet(localModel({local: {quants: [q({id: 'a', bytes: 9}), q({id: 'c', bytes: 3})]}})).id, 'c');
  assert.equal(L.simgQuantToGet(cloudModel()), null);
  assert.equal(L.simgNotDownloaded(cold), true);
  assert.equal(L.simgNotDownloaded(localModel()), false, 'an older catalog without `installed` is not refused');
  assert.equal(L.simgBuildRequest(form(), cold).message, 'Download this model first.');
  assert.equal(L.simgDownloadLabel(L.simgQuantToGet(cold)), 'Download · 12 GB');
  assert.equal(L.simgDownloadLabel(q({downloadBytes: 0, bytes: 0})), 'Download');

  // The offer when nothing is downloaded: the default, else the smallest that runs here without a token.
  const big = localModel({id: 'big', name: 'Big', local: {installed: false, quants: [q({id: 'big:q', downloadBytes: 9e9})]}});
  const small = localModel({id: 'small', name: 'Small', local: {installed: false, quants: [q({id: 'small:q', downloadBytes: 2e9})]}});
  const gated = localModel({id: 'gated', name: 'Gated', local: {installed: false, gated: true, quants: [q({id: 'gated:q', downloadBytes: 1e9})]}});
  const tooBig = localModel({id: 'huge', name: 'Huge', local: {installed: false, quants: [q({id: 'huge:q', downloadBytes: 1e8, fit: {verdict: 'no'}})]}});
  assert.equal(L.simgSuggestDownload(catalog([], [big, gated, tooBig, small])).id, 'small');
  assert.equal(L.simgSuggestDownload(catalog([], [big, Object.assign({}, small, {default: true})])).id, 'small');
  assert.equal(L.simgSuggestDownload(catalog([], [])), null);

  // Progress in words, and which download belongs to a model.
  const dls = {'flux:q8': {id: 'flux:q8', state: 'downloading', percent: 41.6, file: {index: 2, count: 3, name: 'ae.safetensors'}}};
  assert.equal(L.simgDownloadLine(L.simgDownloadOf(cold, dls)), 'Downloading 42% · file 2 of 3');
  assert.equal(L.simgDownloadOf(big, dls), null);
  assert.equal(L.simgDownloadLine({state: 'verifying'}), 'Checking the files…');
  assert.equal(L.simgDownloadLine({state: 'failed', error: {code: 'DISK_SPACE', message: 'Needs 19.7 GB, 12.1 GB free on this disk.'}}), 'Needs 19.7 GB, 12.1 GB free on this disk.');
  assert.match(L.simgDownloadLine({state: 'failed', error: {code: 'GATED', message: 'x'}}), /HF_TOKEN/);
  assert.equal(L.simgLocalUnsupported({local: {engine: {state: 'unsupported'}}}), true);
  assert.equal(L.simgLocalUnsupported(catalog()), false);

  // The page: a Download button with its size, Generate off; the empty local model field offers one.
  const V = req('../renderer/studio/images-view.js');
  globalThis.esc = (x) => String(x).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  globalThis.ic = () => '';
  const lent = Object.keys(L).filter((k) => !(k in globalThis));
  for (const k of lent) globalThis[k] = L[k];
  try {
    const cat = catalog([cloudModel()], [cold]);
    const foot = V.simgvFoot({model: L.simgFindModel(cat, 'flux'), catalog: cat, dl: {}, form: form()});
    assert.match(foot, /data-act="studio:images:download:flux"/);
    assert.match(foot, /Download · 12 GB/);
    assert.match(foot, /class="st-go"[^>]* disabled/);
    const running = V.simgvFoot({model: L.simgFindModel(cat, 'flux'), catalog: cat, dl: dls, form: form()});
    assert.match(running, /Downloading 42%/);
    assert.match(running, /studio:images:dlstop:flux:q8/);
    const empty = V.simgvModelField({model: null, place: 'local', catalog: catalog([cloudModel()], [small]), dl: {}}, null);
    assert.match(empty, /No image model on this Mac yet/);
    assert.match(empty, /studio:images:download:small/);
    const off = V.simgvModelField({model: null, place: 'local', catalog: {cloud: {models: []}, local: {models: [small], engine: {state: 'unsupported'}}}, dl: {}}, null);
    assert.match(off, /cannot make pictures locally\. Switch the chat to the cloud/);
    assert.doesNotMatch(off, /download:/);
  } finally { delete globalThis.esc; delete globalThis.ic; for (const k of lent) delete globalThis[k]; }
});

test('the Images page downloads for the mode in use, and re-reads the catalog after a cancel or an engine change (ATO-1395)', async () => {
  const q = {id: 'flux:q8', quant: 'q8', label: 'Q8', bytes: 12e9, downloadBytes: 12e9, installed: false, recommended: true, fit: {verdict: 'ok'}};
  const cold = localModel({id: 'flux', name: 'FLUX', local: {family: 'flux', loaded: false, installed: false, defaultQuant: 'flux:q8', quants: [q]}});
  const asked = [];
  const P = loadImagesPage(catalog([cloudModel()], [cold]), {studio: {
    localDownload: (id, opts) => { asked.push([id, opts]); return Promise.resolve({ok: true, data: {id, state: 'downloading', transferred: 0, total: 12e9, percent: 0}}); },
    localState: () => Promise.resolve({ok: true, data: {downloads: [], engine: null}}),
  }});
  P.page.onShow();
  await settle();
  P.page.act('download:flux');
  P.page.act('mode:transform');
  P.page.act('download:flux');
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(asked)), [['flux:q8', undefined], ['flux:q8', {workflow: 'transform'}]], 'create sends no workflow, another mode sends its own');
  const before = P.reads();
  P.page.onLocal({type: 'download', download: {id: 'flux:q8', state: 'cancelled'}});
  P.flush();
  await settle();
  assert.equal(P.reads(), before + 1, 'a cancel re-reads the catalog: part files change the size on the button');
  P.page.onLocal({type: 'engine', engine: {state: 'installing'}});
  P.flush();
  await settle();
  assert.equal(P.reads(), before + 1, 'an install in progress reads nothing');
  P.page.onLocal({type: 'engine', engine: {state: 'unsupported', message: 'This computer cannot run local image models.'}});
  P.flush();
  await settle();
  assert.equal(P.reads(), before + 2, 'the engine turning out unsupported re-reads the catalog');
});
