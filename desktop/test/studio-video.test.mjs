// Studio › Video, renderer side: the pure helpers in renderer/studio/video.js
// (form → VideoRequest, length and shape options from the catalog, the
// estimate and price wording, the Generate label) and how the page registers
// with the Studio shell. The module is loaded in a vm context with a stub
// STUDIO and BR; nothing touches Electron or Core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../renderer/studio/video.js', import.meta.url), 'utf8');

function load(extra = {}) {
  const ctx = { console, ...extra };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: 'video.js' });
  return ctx;
}

const V = load().StudioVideo;

const veo = {
  id: 'google/veo-3.1-fast', name: 'Veo 3.1 Fast', provider: 'openrouter', kind: 'video', default: true,
  modes: ['create', 'image-to-video'],
  aspectRatios: { values: ['16:9', '9:16', '1:1'], default: '16:9' },
  resolutions: { values: ['720p', '1080p'], default: '1080p' },
  durations: { values: [4, 6, 8], min: 4, max: 8, default: 8 },
  audio: true, lastFrame: false, negativePrompt: true, nonCommercial: null, adult: null, local: null,
};
const ranged = { ...veo, id: 'x/ranged', default: false, durations: { values: null, min: 5, max: 10, default: 5 }, audio: false, modes: ['create'], negativePrompt: false };
const wan = {
  id: 'wan2.2-5b', name: 'Wan 2.2 5B', provider: 'local', kind: 'video', default: false, modes: ['create'],
  aspectRatios: null, resolutions: null, durations: null,
  sizes: { kind: 'range', min: 256, max: 1280, multiple: 16, defaultWidth: 1280, defaultHeight: 704 },
  audio: false, lastFrame: false, negativePrompt: true, nonCommercial: true, adult: null,
  local: { family: 'wan2.2-5b', developer: 'Alibaba', loaded: true },
};

test('length chips come from the model: its list, or picks inside its range', () => {
  assert.deepEqual([...V.durationOptions(veo)], [4, 6, 8]);
  assert.deepEqual([...V.durationOptions(ranged)], [5, 6, 8, 10]);
  assert.deepEqual([...V.durationOptions(wan)], []);
  assert.deepEqual([...V.durationOptions(null)], []);
  assert.deepEqual([...V.durationOptions({ durations: { values: null, min: null, max: null, default: 6 } })], [6]);
});

test('default length is 4 s (cheapest) even when the model default is longer; a saved one is kept', () => {
  assert.equal(V.pickDuration(veo, null), 4);
  assert.equal(V.pickDuration(veo, 8), 8);
  assert.equal(V.pickDuration(veo, 7), 4);
  assert.equal(V.pickDuration(ranged, null), 5, 'no 4 s: the shortest');
  assert.equal(V.pickDuration(wan, 4), null);
});

test('shape chips: 16:9 and 9:16 where offered; local models get both from their size range', () => {
  assert.deepEqual([...V.aspectOptions(veo)], ['16:9', '9:16']);
  assert.deepEqual([...V.aspectOptions({ ...veo, aspectRatios: { values: ['1:1', '4:3'], default: null } })], ['1:1', '4:3']);
  assert.deepEqual([...V.aspectOptions({ ...veo, aspectRatios: null })], []);
  assert.deepEqual([...V.aspectOptions(wan)], ['16:9', '9:16']);
  assert.deepEqual({ ...V.localDims(wan, '9:16') }, { width: 704, height: 1280 });
  assert.deepEqual({ ...V.localDims(wan, '16:9') }, { width: 1280, height: 704 });
});

test('form → cloud request: only what the model takes', () => {
  const form = { prompt: '  a fox  ', negativePrompt: 'blur', mode: 'text', durationSecs: 6, resolution: '720p', aspectRatio: '9:16', audio: false, firstFrame: { path: '/x.png' } };
  assert.deepEqual({ ...V.buildRequest(form, veo) }, {
    provider: 'openrouter', model: 'google/veo-3.1-fast', mode: 'create', prompt: 'a fox',
    negativePrompt: 'blur', durationSecs: 6, aspectRatio: '9:16', resolution: '720p', audio: false,
  });
  const img = V.buildRequest({ ...form, mode: 'image' }, veo);
  assert.equal(img.mode, 'image-to-video');
  assert.deepEqual({ ...img.firstFrame }, { path: '/x.png' });
  const dropped = V.buildRequest({ ...form, mode: 'image', firstFrame: { base64: 'data:image/png;base64,AA' } }, veo);
  assert.deepEqual({ ...dropped.firstFrame }, { base64: 'data:image/png;base64,AA' });
  const r2 = V.buildRequest({ ...form, durationSecs: 99, resolution: '4K', aspectRatio: '1:1' }, ranged);
  assert.equal(r2.durationSecs, 5, 'a length the model lacks falls back');
  assert.equal(r2.resolution, '1080p');
  assert.equal(r2.aspectRatio, '16:9');
  assert.equal('audio' in r2, false, 'no Sound switch, no audio field');
  assert.equal('negativePrompt' in r2, false);
});

test('form → local request: width and height, no cloud fields, never image-to-video', () => {
  const r = V.buildRequest({ prompt: 'fox', negativePrompt: 'text', mode: 'image', durationSecs: 4, aspectRatio: '9:16', audio: true, firstFrame: { path: '/a.png' } }, wan);
  assert.deepEqual({ ...r }, { provider: 'local', model: 'wan2.2-5b', mode: 'create', prompt: 'fox', negativePrompt: 'text', width: 704, height: 1280 });
  assert.equal(V.blockReason({ mode: 'image', prompt: 'x' }, wan), 'Starting from an image on this Mac is coming soon. Pick a cloud model.');
  assert.equal(V.blockReason({ mode: 'text', prompt: ' ' }, veo), 'Write a prompt first.');
  assert.equal(V.blockReason({ mode: 'image', prompt: '' }, veo), 'Add a first frame.');
  assert.equal(V.blockReason({ mode: 'image', prompt: '', firstFrame: { path: '/a' } }, veo), '');
  assert.equal(V.blockReason({ mode: 'image', prompt: 'x', firstFrame: { path: '/a' } }, ranged), 'This model starts from text only.');
});

test('price params mirror the request', () => {
  const req = V.buildRequest({ prompt: 'x', mode: 'text', durationSecs: 8, resolution: '1080p', aspectRatio: '16:9', audio: true }, veo);
  assert.deepEqual({ ...V.priceParams(req) }, { kind: 'video', durationSecs: 8, resolution: '1080p', audio: true, mode: 'create' });
});

test('price label: ≈ $0.60, a range with maxUsd, nothing when unknown', () => {
  assert.equal(V.priceLabel({ usd: 0.6, maxUsd: null, basis: '' }), '≈ $0.60');
  assert.equal(V.priceLabel({ usd: 0.32, maxUsd: 0.4, basis: '' }), '≈ $0.32–0.40');
  assert.equal(V.priceLabel({ usd: 0.5, maxUsd: 0.5, basis: '' }), '≈ $0.50');
  assert.equal(V.priceLabel(null), '');
  assert.equal(V.priceLabel({ usd: NaN }), '');
  assert.equal(V.generateLabel({ price: { usd: 0.6 }, local: false }), 'Generate · ≈ $0.60');
  assert.equal(V.generateLabel({ price: null, local: false }), 'Generate');
  assert.equal(V.generateLabel({ price: { usd: 0.6 }, local: true }), 'Generate', 'local is free: no number');
  assert.equal(V.generateLabel({ armed: true }), 'Generate anyway');
});

test('estimate verdict text: fits, tight, exceeds (with the swap warning), unknown', () => {
  const est = (verdict, seconds) => ({ memory: { requiredBytes: 1, budgetBytes: 2, pool: 'unified', verdict }, seconds, basis: 'x' });
  assert.deepEqual({ ...V.estimateVerdict(est('fits', { low: 240, high: 420 })) }, { level: 'fits', text: 'takes ~4–7 min · fits in memory', warn: '' });
  assert.equal(V.estimateVerdict(est('tight', { low: 30, high: 45 })).text, 'takes ~30–45 s · tight on memory, close other apps');
  const ex = V.estimateVerdict(est('exceeds', null));
  assert.equal(ex.level, 'exceeds');
  assert.equal(ex.text, "doesn't fit in memory");
  assert.equal(ex.warn, 'Will swap, may take hours');
  assert.equal(V.estimateVerdict(null).level, 'unknown');
  assert.equal(V.spanText(3600, 7200), '~1–2 h');
  assert.equal(V.spanText(60, 60), '~60 s');
  assert.equal(V.fitChip(est('exceeds')).text, 'Too big');
});

test('no em dashes in user-facing wording', () => {
  const strings = SRC.match(/'[^'\n]*'|"[^"\n]*"/g) || [];
  for (const s of strings) assert.ok(!s.includes('—'), 'em dash in ' + s);
});

test('labels: non-commercial and 18+ are shown, local image start says Soon', () => {
  const texts = (m, mode) => V.modelLabels(m, mode).map((l) => l.text);
  assert.ok(texts(wan, 'text').includes('Non-commercial'));
  assert.ok(texts(wan, 'image').includes('Image start: Soon'));
  assert.ok(texts({ ...veo, adult: true }, 'text').includes('18+'));
  assert.ok(texts(veo, 'text').includes('Default'));
});

test('progress: phases, step N of M for local, ETA words', () => {
  const job = { kind: 'video', cloud: false, state: 'generating', progress: { phase: 'sampling', step: 12, totalSteps: 30, fraction: 0.4, etaSeconds: 130, slowdown: false } };
  const ph = V.phaseList(job);
  assert.deepEqual([...ph.map((p) => p.status)], ['done', 'done', 'now', 'next', 'next', 'next']);
  assert.equal(ph[2].text, 'Drawing frames');
  assert.equal(V.stepText(job), 'step 12 of 30');
  assert.equal(V.stepText({ ...job, cloud: true }), '', 'cloud has no real steps');
  assert.equal(V.etaText(130), 'about 2 min left');
  assert.equal(V.etaText(42), 'about 40 s left');
  assert.equal(V.etaText(null), '');
  assert.deepEqual([...V.phaseList({ cloud: true, state: 'generating', progress: { phase: 'sampling' } }).map((p) => p.text)], ['In the queue', 'Rendering', 'Saving the clip']);
});

test('restore settings reads the recipe defensively', () => {
  const p = V.formFromItem({ id: 'j1', prompt: 'p', durationSecs: 6, model: { id: 'google/veo-3.1-fast', name: 'Veo', provider: 'openrouter' },
    recipe: { prompt: 'a fox', workflow: 'image-to-video', remote: { durationSecs: 8, resolution: '720p', aspectRatio: '9:16', generateAudio: false } } });
  assert.equal(p.prompt, 'a fox');
  assert.equal(p.mode, 'image');
  assert.equal(p.durationSecs, 8);
  assert.equal(p.resolution, '720p');
  assert.equal(p.aspectRatio, '9:16');
  assert.equal(p.audio, false);
  assert.equal(p.modelId, 'google/veo-3.1-fast');
  const local = V.formFromItem({ id: 'j2', prompt: 'q', model: { id: 'wan2.2-5b' }, recipe: { width: 704, height: 1280 } });
  assert.equal(local.aspectRatio, '9:16');
  assert.equal(local.prompt, 'q');
});

test('model choice: saved one, else the cloud default; form fitted to it', () => {
  const catalog = { cloud: { models: [ranged, veo], keyMissing: false }, local: { models: [wan] } };
  assert.equal(V.pickModel(catalog, 'wan2.2-5b').id, 'wan2.2-5b');
  assert.equal(V.pickModel(catalog, 'gone').id, veo.id);
  const f = V.fitFormToModel({ durationSecs: 8, aspectRatio: '1:1', resolution: '4K' }, veo);
  assert.equal(f.durationSecs, 8);
  assert.equal(f.aspectRatio, '16:9');
  assert.equal(f.resolution, '1080p');
  assert.equal(f.audio, true);
});

test('registers with STUDIO when it exists at load', () => {
  const calls = [];
  const ctx = load({ STUDIO: { pages: {}, register: (k, p) => calls.push([k, p]) } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'video');
  const page = calls[0][1];
  assert.equal(page.title, 'Video');
  for (const fn of ['render', 'onEvent', 'onShow', 'onHide']) assert.equal(typeof page[fn], 'function', fn);
  assert.ok(ctx.StudioVideo);
});

test('waits for STUDIO when the shell loads later', async () => {
  const calls = [];
  const ctx = load({ document: {}, setTimeout });
  assert.equal(calls.length, 0);
  ctx.STUDIO = { pages: {}, register: (k) => calls.push(k) };
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(calls, ['video']);
});

test('onEvent with a finished job before render does not throw', () => {
  let page;
  load({ STUDIO: { pages: {}, register: (_k, p) => { page = p; } } });
  page.onEvent({ id: 'j', kind: 'video', state: 'generating', cloud: true, progress: { phase: 'sampling', fraction: 0.2 } });
  page.onEvent({ id: 'j', kind: 'image', state: 'completed' });
  page.onHide();
  assert.equal(page._state.job.id, 'j');
});

test('posters: only a Studio clip without one, tried once per session', () => {
  const clip = { id: 'job-1', path: '/data/studio/videos/job-1.webm', thumbnailPath: null };
  assert.equal(V.needsPoster(clip, {}), true);
  assert.equal(V.needsPoster({ ...clip, thumbnailPath: '/data/studio/videos/job-1.thumb.png' }, {}), false);
  assert.equal(V.needsPoster(clip, { 'job-1': true }), false);
  assert.equal(V.needsPoster({ ...clip, id: 'chat:/x.mp4', fromChat: true }, {}), false);
  assert.equal(V.needsPoster({ ...clip, path: '' }, {}), false);
  assert.equal(V.needsPoster(null, {}), false);
  assert.equal(V.posterTime(8), 0.5);
  assert.equal(V.posterTime(0.6), 0.3);
  assert.equal(V.posterTime(NaN), 0.5);
});

test('posters for clips from a chat: drawn when not tried yet, never for a gallery clip', () => {
  const chat = { id: 'chat:/home/u/clip.mp4', path: '/home/u/clip.mp4', fromChat: true, thumbnailPath: null };
  assert.equal(V.needsChatPoster(chat, {}), true);
  assert.equal(V.needsChatPoster(chat, { [chat.id]: true }), false);
  assert.equal(V.needsChatPoster({ ...chat, path: '' }, {}), false);
  assert.equal(V.needsChatPoster({ id: 'job-1', path: '/data/studio/videos/job-1.webm', thumbnailPath: null }, {}), false);
  assert.equal(V.needsChatPoster(null, {}), false);
});

test('a clip opened from a chat gets an in-memory poster; Core is not asked to keep it', async () => {
  const made = [];
  const document = {
    createElement(tag) {
      if (tag === 'canvas') return { width: 0, height: 0, getContext: () => ({ drawImage() {} }), toDataURL: () => 'data:image/png;base64,QUJD' };
      const on = {};
      const v = {
        videoWidth: 1280, videoHeight: 720, duration: 4,
        addEventListener: (ev, fn) => { on[ev] = fn; },
        removeAttribute() {}, load() {},
        set currentTime(_t) { setImmediate(() => on.seeked && on.seeked()); },
        set src(_s) { setImmediate(() => on.loadedmetadata && on.loadedmetadata()); },
      };
      made.push(v);
      return v;
    },
  };
  const setPosterCalls = [];
  let page;
  load({
    document, setTimeout, clearTimeout,
    STUDIO: { pages: {}, register: (_k, p) => { page = p; }, mediaUrl: (p) => 'file://' + p },
    atomic: { studio: { setPoster: async (...a) => { setPosterCalls.push(a); return { ok: true, data: null }; } } },
  });
  page.focusFile('/home/u/clip.mp4');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(page._state.result.fromChat, true);
  assert.equal(page._state.thumbs['chat:/home/u/clip.mp4'], 'data:image/png;base64,QUJD');
  assert.equal(setPosterCalls.length, 0);
  assert.equal(made.length, 1);
  page.focusFile('/home/u/clip.mp4');   // tried once per session
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(made.length, 1);
});
