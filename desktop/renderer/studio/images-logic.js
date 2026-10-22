/* Studio › Images: the pure part. The catalog's models, which modes they can
   run, the form turned into a BR.studio.generateImage request, the price on
   the Generate button, the progress card's words and a gallery item's recipe
   turned back into a form. No DOM, no BR: images.js draws and calls, and the
   unit suite (desktop/test/studio-images.test.mjs) checks this file alone.

   Shapes: renderer/studio/CONTRACT.md. Loaded before images.js; every name
   here starts with `simg` so it cannot meet one of renderer.js's globals. */

const SIMG_MODES = [
  ['create', 'Create'], ['edit', 'Edit'], ['reference', 'Reference'], ['transform', 'Transform'],
  ['inpaint', 'Inpaint'], ['extend', 'Extend'], ['upscale', 'Upscale'],
];
/** One line under the mode tabs: what the chosen mode does, in plain words. */
const SIMG_MODE_HINT = {
  create: 'Make new pictures from your words.',
  edit: 'Change your picture with words. Describe only what should change.',
  reference: 'Make a new picture that follows the look of your images.',
  transform: 'Redraw your picture in a new style. Strength sets how far it may move.',
  inpaint: 'Repaint part of your picture. White areas of the mask get redrawn.',
  extend: 'Grow the canvas past its edges. White areas of the mask get filled.',
  upscale: 'Make your picture bigger and sharper. No prompt needed.',
};
const SIMG_NEEDS_MASK = new Set(['inpaint', 'extend']);
/** Rough pixel sizes per ratio (main/studio-requests.ts RATIO_PIXELS), for local range-size models. */
const SIMG_RATIO = {
  '1:1': [1, 1], '16:9': [16, 9], '9:16': [9, 16], '4:3': [4, 3], '3:4': [3, 4], '3:2': [3, 2], '2:3': [2, 3],
  '21:9': [21, 9], '9:21': [9, 21], '4:5': [4, 5], '5:4': [5, 4],
};
const SIMG_LOCAL_RATIOS = ['1:1', '4:5', '4:3', '16:9', '9:16'];

/** Every model of a catalog answer, cloud first, each with its group. */
function simgModels(catalog) {
  if (!catalog) return [];
  const cloud = (catalog.cloud && catalog.cloud.models) || [];
  const local = (catalog.local && catalog.local.models) || [];
  return cloud.map((m) => Object.assign({}, m, {group: 'cloud'}))
    .concat(local.map((m) => Object.assign({}, m, {group: 'local'})));
}

function simgFindModel(catalog, id, provider) {
  if (!id) return null;
  return simgModels(catalog).find((m) => m.id === id && (!provider || m.provider === provider)) || null;
}

/** The model a fresh form starts on: the cloud default, else a loaded local one, else the first. */
function simgDefaultModel(catalog) {
  const all = simgModels(catalog);
  return all.find((m) => m.group === 'cloud' && m.default)
    || all.find((m) => m.group === 'cloud')
    || all.find((m) => m.local && m.local.loaded)
    || all[0] || null;
}

/** A mode as the end of "<model> cannot ...". */
const SIMG_MODE_VERB = {
  create: 'create pictures', edit: 'edit', reference: 'use references', transform: 'transform',
  inpaint: 'inpaint', extend: 'extend', upscale: 'upscale',
};

/** The mode tabs for a model: each enabled or greyed with the reason.
    `need` says why a greyed one is off: 'local' (only a model on this Mac runs it),
    'model' (this model cannot), 'pick' (no model chosen). */
function simgModeTabs(model, catalog) {
  const locals = simgModels(catalog).filter((m) => m.group === 'local');
  return SIMG_MODES.map(([id, label]) => {
    if (!model) return {id, label, ok: id === 'create', why: id === 'create' ? '' : 'Pick a model first', need: id === 'create' ? '' : 'pick'};
    const ok = (model.modes || []).includes(id);
    let why = '', need = '';
    if (!ok) {
      const localCan = locals.some((m) => (m.modes || []).includes(id));
      need = model.group === 'cloud' && localCan ? 'local' : 'model';
      why = need === 'local' ? 'Needs a model on this Mac' : model.name + ' cannot do this';
    }
    return {id, label, ok, why, need};
  });
}

const simgList = (xs, conj) => (xs.length === 1 ? xs[0] : xs.slice(0, -1).join(', ') + ' ' + conj + ' ' + xs[xs.length - 1]);

/** One hint line for the greyed modes: the ones a model on this Mac runs, then the
    ones the chosen model cannot do ("Nano Banana cannot inpaint, extend or upscale."). */
function simgModeNote(tabs, model) {
  const out = [];
  const off = tabs.filter((t) => !t.ok && t.why === 'Needs a model on this Mac').map((t) => t.label);
  if (off.length) out.push(simgList(off, 'and') + (off.length === 1 ? ' needs' : ' need') + ' a model on this Mac.');
  const cannot = model ? tabs.filter((t) => !t.ok && t.need === 'model').map((t) => SIMG_MODE_VERB[t.id]) : [];
  if (cannot.length) out.push(model.name + ' cannot ' + simgList(cannot, 'or') + '.');
  return out.join(' ');
}

/** The hint line's words after a click on one greyed mode. */
function simgModeWhy(tab, model) {
  if (!tab || tab.ok) return '';
  if (tab.need === 'local') return tab.label + ' needs a model on this Mac.';
  if (tab.need === 'model' && model) return model.name + ' cannot ' + SIMG_MODE_VERB[tab.id] + '.';
  return 'Pick a model first.';
}

/** Whether another model in the catalog runs one of these modes (the hint's "Pick one" link). */
function simgOtherCan(catalog, model, modes) {
  return simgModels(catalog).some((m) => !(model && m.id === model.id && m.provider === model.provider)
    && modes.some((id) => (m.modes || []).includes(id)));
}

/** The ratios offered as shape tiles: the model's own, or a short list for range sizes. */
function simgRatios(model) {
  if (!model) return [];
  if (model.aspectRatios && model.aspectRatios.values && model.aspectRatios.values.length) return model.aspectRatios.values.slice();
  if (model.sizes && model.sizes.kind === 'range') return SIMG_LOCAL_RATIOS.slice();
  return [];
}

/** A tile's little frame drawn from the ratio, its longer side 22px (a thin side
    never under 4px); null for a value that is not a ratio ("auto"), which gets an icon. */
function simgRatioBox(ratio) {
  const m = SIMG_RATIO[ratio] || (String(ratio).match(/^(\d+(?:\.\d+)?)\s*[:x]\s*(\d+(?:\.\d+)?)$/) || []).slice(1).map(Number);
  const w = Number(m[0]), h = Number(m[1]);
  if (!(w > 0 && h > 0)) return null;
  const k = 22 / Math.max(w, h);
  return [Math.max(4, Math.round(w * k)), Math.max(4, Math.round(h * k))];
}

/** Width and height for a range-size model at a ratio, about the model's default area, on its multiple. */
function simgRangeSize(sizes, ratio) {
  const r = SIMG_RATIO[ratio] || [1, 1];
  const area = (sizes.defaultWidth || 1024) * (sizes.defaultHeight || 1024);
  const mult = sizes.multiple || 64;
  const clamp = (v) => Math.min(sizes.max || 8192, Math.max(sizes.min || 64, Math.round(v / mult) * mult));
  const w = Math.sqrt(area * r[0] / r[1]);
  return [clamp(w), clamp(w * r[1] / r[0])];
}

const simgRange = (spec, v) => {
  const n = Number(v);
  if (!spec || !Number.isFinite(n)) return spec ? spec.default : undefined;
  return Math.min(spec.max, Math.max(spec.min, n));
};

/** The form's settings that belong to a model, set to that model's defaults. */
function simgModelDefaults(model) {
  if (!model) return {};
  return {
    aspect: model.aspectRatios ? (model.aspectRatios.default || model.aspectRatios.values[0] || '') : (simgRatios(model)[0] || ''),
    resolution: model.resolutions ? (model.resolutions.default || model.resolutions.values[0] || '') : '',
    size: model.sizes && model.sizes.kind === 'enum' ? (model.sizes.default || model.sizes.values[0] || '') : '',
    steps: model.steps ? model.steps.default : null,
    cfg: model.cfg ? model.cfg.default : null,
    guidance: model.guidance ? model.guidance.default : null,
    strength: model.strength ? model.strength.default : null,
  };
}

/** A form after a model or mode change: every value one the model takes. */
function simgNormalize(form, model) {
  const f = Object.assign({}, form);
  if (!model) return f;
  const d = simgModelDefaults(model);
  if (!(model.modes || []).includes(f.mode)) f.mode = (model.modes || []).includes('create') ? 'create' : ((model.modes || [])[0] || 'create');
  const ratios = simgRatios(model);
  if (f.aspect !== 'source' && !ratios.includes(f.aspect)) f.aspect = d.aspect;
  if (f.aspect === 'source' && f.mode === 'create') f.aspect = d.aspect;
  if (!model.resolutions || !model.resolutions.values.includes(f.resolution)) f.resolution = d.resolution;
  if (!(model.sizes && model.sizes.kind === 'enum' && model.sizes.values.includes(f.size))) f.size = d.size;
  f.count = Math.min(Math.max(1, Math.round(Number(f.count) || 1)), Math.max(1, model.maxCount || 1));
  for (const [k, spec] of [['steps', model.steps], ['cfg', model.cfg], ['guidance', model.guidance], ['strength', model.strength]]) {
    f[k] = spec ? (f[k] === null || f[k] === undefined ? spec.default : simgRange(spec, f[k])) : null;
  }
  const max = model.maxInputImages || 16;
  if (Array.isArray(f.refs) && f.refs.length > Math.max(0, max - 1)) f.refs = f.refs.slice(0, Math.max(0, max - 1));
  return f;
}

const simgSource = (s) => (s && s.path ? {path: s.path} : s && s.base64 ? {base64: s.base64} : null);

/** The form as BR.studio.generateImage's request, or why it cannot go yet. */
function simgBuildRequest(form, model) {
  if (!model) return {ok: false, message: 'Pick a model first.'};
  const mode = form.mode || 'create';
  if (!(model.modes || []).includes(mode)) return {ok: false, message: model.name + ' cannot do this mode.'};
  const prompt = String(form.prompt || '').trim();
  if (!prompt && mode !== 'upscale') return {ok: false, message: 'Write a prompt first.'};
  const req = {provider: model.provider === 'local' ? 'local' : 'openrouter', model: model.id, mode, prompt};
  if (mode !== 'create') {
    const src = simgSource(form.source);
    if (!src) return {ok: false, message: 'Add a source image first.'};
    req.initImage = src;
  }
  if (SIMG_NEEDS_MASK.has(mode)) {
    const mask = simgSource(form.mask);
    if (!mask) return {ok: false, message: 'Add a mask first. White areas get redrawn.'};
    req.maskImage = mask;
  }
  if (mode === 'reference' && Array.isArray(form.refs) && form.refs.length) {
    const room = Math.max(0, (model.maxInputImages || 16) - 1);
    const refs = form.refs.map(simgSource).filter(Boolean).slice(0, room);
    if (refs.length) req.referenceImages = refs;
  }
  if (mode !== 'upscale') req.count = Math.min(Math.max(1, Math.round(Number(form.count) || 1)), Math.max(1, model.maxCount || 1));
  if (model.negativePrompt && String(form.negative || '').trim()) req.negativePrompt = String(form.negative).trim();
  if (model.seed && form.seedLocked && Number.isInteger(Number(form.seed)) && String(form.seed).trim() !== '') req.seed = Number(form.seed);
  const keepSource = form.aspect === 'source' && mode !== 'create';
  if (!keepSource && form.aspect && mode !== 'upscale') {
    if (model.aspectRatios && model.aspectRatios.values.includes(form.aspect)) req.aspectRatio = form.aspect;
    else if (model.sizes && model.sizes.kind === 'range') [req.width, req.height] = simgRangeSize(model.sizes, form.aspect);
  }
  if (model.resolutions && form.resolution) req.resolution = form.resolution;
  if (model.sizes && model.sizes.kind === 'enum' && form.size) req.size = form.size;
  if (model.steps && form.steps !== null && form.steps !== undefined) req.steps = Math.round(simgRange(model.steps, form.steps));
  if (model.cfg && form.cfg !== null && form.cfg !== undefined) req.cfgScale = simgRange(model.cfg, form.cfg);
  if (model.guidance && form.guidance !== null && form.guidance !== undefined) req.guidance = simgRange(model.guidance, form.guidance);
  if (model.strength && mode !== 'create' && form.strength !== null && form.strength !== undefined) req.strength = simgRange(model.strength, form.strength);
  return {ok: true, req};
}

/** What BR.studio.price is asked for this form. Local models have no price. */
function simgPriceParams(form, model) {
  if (!model || model.provider === 'local') return null;
  const p = {kind: 'image', count: form.mode === 'upscale' ? 1 : Math.max(1, Number(form.count) || 1), mode: form.mode || 'create'};
  if (model.resolutions && form.resolution) p.resolution = form.resolution;
  return p;
}

function simgUsd(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '';
  if (v === 0) return '$0';
  if (v < 0.01) return '$' + v.toFixed(3).replace(/0+$/, '');
  return '$' + v.toFixed(2);
}

/** "≈ $0.04", "≈ $0.32–0.40", or '' when there is no number. */
function simgPriceLabel(price) {
  if (!price || typeof price.usd !== 'number' || !Number.isFinite(price.usd)) return '';
  const lo = simgUsd(price.usd);
  if (!lo) return '';
  if (typeof price.maxUsd === 'number' && Number.isFinite(price.maxUsd) && price.maxUsd > price.usd) {
    return '≈ ' + lo + '–' + simgUsd(price.maxUsd).slice(1);
  }
  return '≈ ' + lo;
}

/** The Generate button's words: the price only when there is one. */
function simgGenerateLabel(price) {
  const p = simgPriceLabel(price);
  return p ? 'Generate · ' + p : 'Generate';
}

const SIMG_PHASE = {
  queued: 'Waiting to start', encoding: 'Reading your prompt', sampling: 'Drawing',
  decoding: 'Finishing', postprocessing: 'Finishing', saving: 'Saving',
};
/** The progress card's steps, in order, for the list under the bar. */
const SIMG_PHASE_ORDER = [['queued', 'Waiting to start'], ['encoding', 'Reading your prompt'], ['sampling', 'Drawing'], ['saving', 'Finishing and saving']];

function simgEta(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s) || s <= 0) return '';
  if (s < 60) return 'about ' + Math.max(1, Math.round(s)) + ' s left';
  const m = Math.round(s / 60);
  return 'about ' + m + ' min left';
}

/** The words of the progress card for a job. */
function simgProgress(job) {
  const p = (job && job.progress) || {};
  const n = p.batchSize > 1 ? (Number(p.batchIndex) || 0) + 1 : 0;
  const title = job && job.state === 'queued' ? 'Waiting to start'
    : n ? 'Making image ' + Math.min(n, p.batchSize) + ' of ' + p.batchSize : 'Making your image';
  const phase = SIMG_PHASE[p.phase] || (job && job.state === 'queued' ? 'Waiting to start' : 'Working');
  const steps = job && !job.cloud && p.totalSteps > 0 && p.phase === 'sampling' ? ' · step ' + p.step + ' of ' + p.totalSteps : '';
  const fraction = Math.min(1, Math.max(0, Number(p.fraction) || 0));
  const at = p.phase === 'decoding' || p.phase === 'postprocessing' ? 'saving' : p.phase;
  const idx = SIMG_PHASE_ORDER.findIndex(([id]) => id === at);
  return {title, line: phase + steps, eta: simgEta(p.etaSeconds), fraction, phaseIndex: idx};
}

const SIMG_WORKFLOW = new Set(SIMG_MODES.map(([id]) => id));
const simgObj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/** A gallery item's recipe (Core's ImageRecipe, verbatim) as form values: Restore these settings. */
function simgRecipeToForm(item) {
  const r = simgObj(item && item.recipe);
  const remote = simgObj(r.remote);
  const target = simgObj(r.target);
  const f = {};
  const prompt = typeof r.prompt === 'string' ? r.prompt : (item && item.prompt) || '';
  if (prompt) f.prompt = prompt;
  if (typeof r.negativePrompt === 'string') f.negative = r.negativePrompt;
  const mode = r.workflow || r.mode;
  if (SIMG_WORKFLOW.has(mode)) f.mode = mode;
  if (Number.isInteger(r.seed)) { f.seed = r.seed; f.seedLocked = true; }
  const count = r.batchSize || r.count;
  if (Number.isInteger(count) && count > 0) f.count = count;
  if (typeof remote.aspectRatio === 'string') f.aspect = remote.aspectRatio;
  else if (typeof r.aspectRatio === 'string') f.aspect = r.aspectRatio;
  if (typeof remote.resolution === 'string') f.resolution = remote.resolution;
  if (typeof remote.size === 'string') f.size = remote.size;
  if (Number(r.steps) > 0) f.steps = Number(r.steps);
  if (Number(r.cfgScale) > 0) f.cfg = Number(r.cfgScale);
  if (Number(r.guidance) > 0) f.guidance = Number(r.guidance);
  if (typeof r.strength === 'number') f.strength = r.strength;
  const model = (item && item.model) || {};
  f.modelId = typeof target.model === 'string' ? target.model : model.id || null;
  f.provider = typeof target.provider === 'string' ? (target.provider === 'local' ? 'local' : 'openrouter')
    : model.provider === 'local' ? 'local' : model.provider ? 'openrouter' : null;
  return f;
}

/** The model row's second line: maker or family, and where it runs. */
function simgModelMeta(model) {
  if (!model) return '';
  if (model.group === 'local' || model.provider === 'local') {
    const dev = model.local && model.local.developer;
    return (dev ? dev + ' · ' : '') + 'On this Mac';
  }
  const maker = simgMaker(String(model.id || '').split('/')[0]);
  return (maker ? maker + ' · ' : '') + 'via OpenRouter';
}

/** OpenRouter's maker slug as the maker's own name; other slugs word by word. */
const SIMG_MAKERS = {
  openai: 'OpenAI', google: 'Google', 'black-forest-labs': 'Black Forest Labs', bytedance: 'ByteDance',
  'bytedance-seed': 'ByteDance', 'x-ai': 'xAI', stabilityai: 'Stability AI', 'stability-ai': 'Stability AI',
  recraft: 'Recraft', ideogram: 'Ideogram', qwen: 'Qwen', 'z-ai': 'Z.ai', minimax: 'MiniMax', 'meta-llama': 'Meta',
};
function simgMaker(slug) {
  if (!slug) return '';
  return SIMG_MAKERS[slug] || slug.split(/[-_]/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** The labels a model carries: Non-commercial and 18+ are shown, never hidden. */
function simgModelTags(model) {
  const out = [];
  if (!model) return out;
  if (model.nonCommercial) out.push({cls: 'soft', text: 'Non-commercial'});
  if (model.adult) out.push({cls: 'bad', text: '18+'});
  return out;
}

/** Local model chips: size and fit when the catalog knows them, else whether it is ready. */
function simgLocalChips(model) {
  const out = [];
  const l = (model && model.local) || {};
  const bytes = Number(l.sizeBytes || model.sizeBytes);
  if (bytes > 0) out.push({cls: '', text: (bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1) + ' GB'});
  const fit = l.fit || model.fit;
  if (fit === 'fits') out.push({cls: 'local', text: 'Fits'});
  else if (fit === 'tight') out.push({cls: 'warn', text: 'Tight'});
  else if (fit === 'exceeds') out.push({cls: 'bad', text: 'Too big'});
  out.push(l.loaded ? {cls: 'local', text: 'Ready'} : {cls: 'soft', text: 'Not loaded'});
  return out;
}

/** The modes a model can run, for its row in the picker. */
function simgModesLine(model) {
  const names = SIMG_MODES.filter(([id]) => (model.modes || []).includes(id)).map(([, l]) => l);
  return names.join(' · ');
}

if (typeof module !== 'undefined') {
  module.exports = {SIMG_MODES, SIMG_MODE_HINT, simgModels, simgFindModel, simgDefaultModel, simgModeTabs, simgModeNote, simgModeWhy, simgOtherCan,
    simgRatios, simgRatioBox, simgRangeSize, simgModelDefaults, simgNormalize, simgBuildRequest, simgPriceParams,
    simgPriceLabel, simgGenerateLabel, simgEta, simgProgress, simgRecipeToForm, simgModelMeta, simgMaker, simgModelTags,
    simgLocalChips, simgModesLine, SIMG_PHASE_ORDER};
}
