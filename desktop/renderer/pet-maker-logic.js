/* ---------------- ATO-2513: "Make your own pet", the pure half ----------------
   Loaded before pet-maker.js (the dialog). Four pictures make a pet (idle,
   working, waiting, sleeping; main/pet-skins.ts maps the seven states onto
   them), drawn by Studio's image generation: the same Core jobs the agent's
   image.generate runs. A local model is free; a cloud one is paid, and its
   price is on the Make button before anything runs, as Studio's Generate
   button shows it (studio/images-logic.js simgGenerateLabel).

   Exported under Node for test/pet-maker.test.mjs. */

const PETM_FRAMES = ['idle', 'working', 'waiting', 'sleeping'];

const PETM_POSES = {
  idle: 'calm and content, eyes open, sitting still',
  working: 'busy and focused, holding a tiny wrench',
  waiting: 'looking up with one hand raised, an exclamation mark floating above its head',
  sleeping: 'asleep with its eyes closed, curled up, small floating z shapes',
};

/** The prompt of one picture. With `same`, the first picture goes along as the reference. */
function petmPrompt(desc, frame, same) {
  const who = String(desc || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const pose = PETM_POSES[frame] || PETM_POSES.idle;
  return (same ? 'The same character as in the reference picture: ' : 'A small cute mascot character for a desktop pet: ')
    + who + '. ' + pose[0].toUpperCase() + pose.slice(1)
    + '. Centered, the whole body in view, simple flat illustration, plain white background, no text.';
}

/**
 * The models a pet can be made with, from BR.studio.catalog('image'):
 * downloaded local models first (free), then cloud ones when an OpenRouter
 * key is set. A model that cannot draw from nothing ('create') is left out.
 */
function petmModels(catalog) {
  const out = [];
  const local = catalog && catalog.local && Array.isArray(catalog.local.models) ? catalog.local.models : [];
  const cloud = catalog && catalog.cloud && Array.isArray(catalog.cloud.models) ? catalog.cloud.models : [];
  const opt = (m, provider, model) => {
    const modes = Array.isArray(m.modes) ? m.modes : [];
    const ratios = m.aspectRatios && Array.isArray(m.aspectRatios.values) ? m.aspectRatios.values : [];
    const bgs = m.background && Array.isArray(m.background.values) ? m.background.values : [];
    return {
      key: provider + ':' + model,
      provider, model,
      id: m.id,
      name: String(m.name || m.id),
      free: provider === 'local',
      reference: modes.includes('reference') && (m.maxInputImages == null || m.maxInputImages >= 1),
      ratio: ratios.includes('1:1') ? '1:1' : null,
      background: bgs.includes('transparent') ? 'transparent' : null,
    };
  };
  for (const m of local) {
    if (!m || !m.local || !m.local.installed || !Array.isArray(m.modes) || !m.modes.includes('create')) continue;
    out.push(opt(m, 'local', m.local.defaultQuant || m.id));
  }
  if (!(catalog && catalog.cloud && catalog.cloud.keyMissing)) {
    for (const m of cloud) {
      if (!m || !Array.isArray(m.modes) || !m.modes.includes('create')) continue;
      out.push(opt(m, 'openrouter', m.id));
    }
  }
  return out;
}

/** One picture's request for BR.studio.generateImage (studio/CONTRACT.md ImageRequest). */
function petmRequest(option, desc, frame, reference) {
  const same = !!(reference && option.reference);
  const req = {provider: option.provider, model: option.model, mode: same ? 'reference' : 'create', prompt: petmPrompt(desc, frame, same), count: 1};
  if (same) req.referenceImages = [{base64: reference}];
  if (option.ratio) req.aspectRatio = option.ratio;
  if (option.background) req.background = option.background;
  return req;
}

function petmUsd(n) {
  if (n === 0) return '$0';
  return n < 0.01 ? '$' + n.toFixed(3).replace(/0+$/, '') : '$' + n.toFixed(2);
}

/**
 * The price line under the form and the Make button's words. `price` is
 * BR.studio.price(id, {kind: 'image', count: 4}): undefined while it is
 * asked, null when OpenRouter lists none. Never a made-up number.
 */
function petmPrice(option, price) {
  const n = PETM_FRAMES.length;
  if (!option) return {line: '', button: 'Make my pet', ready: false};
  if (option.free) return {line: 'Free: the ' + n + ' pictures are made on this computer.', button: 'Make my pet', ready: true};
  if (price === undefined) return {line: 'Checking the price…', button: 'Make my pet', ready: false};
  if (price && typeof price.usd === 'number' && Number.isFinite(price.usd) && price.usd >= 0) {
    const hi = typeof price.maxUsd === 'number' && Number.isFinite(price.maxUsd) && price.maxUsd > price.usd ? '–' + petmUsd(price.maxUsd).slice(1) : '';
    const total = '≈ ' + petmUsd(price.usd) + hi;
    return {line: 'About ' + petmUsd(price.usd) + hi + ' for ' + n + ' pictures, charged by OpenRouter to your key.', button: 'Make my pet · ' + total, ready: true};
  }
  const t = price && price.perToken;
  if (t && typeof t.usdPerMillion === 'number' && t.usdPerMillion > 0) {
    return {line: 'OpenRouter bills this model per token ($' + t.usdPerMillion + ' per 1M output tokens), so the exact cost of the ' + n + ' pictures shows when they are done.', button: 'Make my pet (paid)', ready: true};
  }
  return {line: 'OpenRouter charges for each of the ' + n + ' pictures. It lists no price for this model.', button: 'Make my pet (paid)', ready: true};
}

/** A finished Studio job → 'done', 'failed', 'stopped', or null while it runs. */
function petmJobEnd(job) {
  const st = job && job.state;
  if (st === 'completed') return job.outputs && job.outputs[0] && job.outputs[0].path ? 'done' : 'failed';
  if (st === 'failed') return 'failed';
  if (st === 'cancelled') return 'stopped';
  return null;
}

/** A picture's data URL from BR.studio.preview's answer, either envelope. */
function petmDataUrl(res) {
  const d = res && res.ok && res.data ? res.data : res;
  const url = d && d.ok !== false ? d.dataUrl : null;
  return typeof url === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(url) ? url : null;
}

/** "Making picture 2 of 4: working" for the progress line. */
function petmProgressLine(i, frame) {
  return 'Making picture ' + (i + 1) + ' of ' + PETM_FRAMES.length + ': ' + frame + '…';
}

if (typeof module !== 'undefined') {
  module.exports = {PETM_FRAMES, petmPrompt, petmModels, petmRequest, petmPrice, petmJobEnd, petmDataUrl, petmProgressLine};
}
