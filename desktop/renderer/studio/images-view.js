/* Studio › Images: the page's HTML, built from images.js's state (IM) and the
   pure helpers in images-logic.js. Strings only: images.js writes them into
   the page and puts decoded pictures into the empty `data-pic` slots after
   (the window's CSP allows only data: images, and a 15 MB data URL does not
   belong in an innerHTML string).

   Every control is `data-act="studio:images:<verb>"`, the window's click
   delegate (act → STUDIO.act → images.js act). Globals read when a function
   runs: esc, ic (renderer.js). */

const SIMGV_A = (verb) => 'data-act="studio:images:' + esc(verb) + '"';
const SIMGV_IDEAS = ['A fox reading under a lamp', 'Isometric tiny office', 'Poster for a jazz night'];

function simgvTag(t) {
  return '<span class="st-tag' + (t.cls ? ' ' + t.cls : '') + '">' + esc(t.text) + '</span>';
}

function simgvLogo(model) {
  const name = String((model && model.name) || '?');
  const letter = (name.match(/[A-Za-z0-9]/) || ['?'])[0].toUpperCase();
  return '<span class="st-mlogo' + (model && model.group === 'local' ? ' local' : '') + '" aria-hidden="true">' + esc(letter) + '</span>';
}

function simgvTop(IM) {
  const dir = IM.dir ? IM.dir.replace(/^\/Users\/[^/]+/, '~') : 'Images folder';
  return '<div class="st-top"><h2>Images</h2><span class="st-sub">Make and edit pictures from a prompt</span><span class="st-sp"></span>'
    + '<button class="st-pill" ' + SIMGV_A('folder') + ' title="Change where new images are saved">' + ic('folder') + '<span>' + esc(dir) + '</span></button></div>';
}

/* ---------- form ---------- */

function simgvSource(IM, slot, label, sub) {
  const s = slot === 'mask' ? IM.form.mask : IM.form.source;
  const picking = IM.picking === slot;
  if (s) {
    return '<div class="st-drop filled" data-drop="' + slot + '">'
      + '<div class="st-src" data-pic="' + esc(s.key) + '"></div>'
      + '<div class="st-dropt"><div class="dt">' + esc(s.name || 'Image') + '</div><div class="ds">' + esc(s.note || '') + '</div></div>'
      + '<button class="iconbtn st-x" ' + SIMGV_A('clear:' + slot) + ' title="Remove" aria-label="Remove">' + ic('x') + '</button></div>';
  }
  return '<div class="st-drop' + (picking ? ' picking' : '') + '" data-drop="' + slot + '">'
    + '<div class="st-di">' + ic('upload') + '</div>'
    + '<div class="st-dropt"><div class="dt">' + esc(label) + '</div><div class="ds">' + esc(sub) + '</div>'
      + '<div class="st-droplinks"><button class="st-link" ' + SIMGV_A('pick:' + slot) + '>Choose file</button>'
      + '<button class="st-link" ' + SIMGV_A('fromlib:' + slot) + '>' + (picking ? 'Click a picture below' : 'Pick from gallery') + '</button></div></div></div>';
}

function simgvRefs(IM, model) {
  const max = Math.max(0, ((model && model.maxInputImages) || 16) - 1);
  const refs = IM.form.refs || [];
  if (!max) return '';
  return '<div><div class="st-lbl">More references <span class="r">' + refs.length + ' of ' + max + '</span></div>'
    + '<div class="st-refs">' + refs.map((r, i) => '<div class="st-ref" data-pic="' + esc(r.key) + '" title="' + esc(r.name || '') + '">'
      + '<button class="st-refx" ' + SIMGV_A('unref:' + i) + ' aria-label="Remove">' + ic('x') + '</button></div>').join('')
    + (refs.length < max ? '<button class="st-ref add" ' + SIMGV_A('pick:ref') + ' title="Add reference images" aria-label="Add reference images">' + ic('plus') + '</button>' : '')
    + '</div></div>';
}

function simgvAspects(IM, model) {
  const ratios = simgRatios(model);
  const f = IM.form;
  const tiles = [];
  if (f.mode !== 'create') tiles.push(['source', 'Keep', null]);
  for (const r of ratios) tiles.push([r, r, simgRatioBox(r)]);
  if (!tiles.length) return '';
  return '<div><div class="st-lbl">Shape</div><div class="st-aspects">'
    + tiles.slice(0, 10).map(([id, label, box]) => '<button class="st-asp' + (f.aspect === id ? ' on' : '') + '" ' + SIMGV_A('aspect:' + id) + ' aria-pressed="' + (f.aspect === id) + '">'
      + (box ? '<i style="width:' + box[0] + 'px;height:' + box[1] + 'px"></i>' : ic('image')) + esc(label) + '</button>').join('')
    + '</div></div>';
}

function simgvSelect(id, values, cur) {
  return '<select class="st-sel" id="' + id + '">' + values.map((v) => '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(v) + '</option>').join('') + '</select>';
}

function simgvCountRow(IM, model) {
  const f = IM.form;
  const cells = [];
  if (f.mode !== 'upscale') {
    const max = Math.max(1, (model && model.maxCount) || 1);
    cells.push('<div><div class="st-lbl">How many</div><div class="st-stepper">'
      + '<button ' + SIMGV_A('count:-1') + (f.count <= 1 ? ' disabled' : '') + ' aria-label="Fewer">' + ic('minus') + '</button>'
      + '<b class="tnum">' + f.count + '</b>'
      + '<button ' + SIMGV_A('count:1') + (f.count >= max ? ' disabled' : '') + ' aria-label="More">' + ic('plus') + '</button></div></div>');
  }
  if (model && model.resolutions && model.resolutions.values.length > 1) {
    cells.push('<div><div class="st-lbl">Quality</div>' + simgvSelect('sti-res', model.resolutions.values, f.resolution) + '</div>');
  } else if (model && model.sizes && model.sizes.kind === 'enum' && model.sizes.values.length > 1) {
    cells.push('<div><div class="st-lbl">Size</div>' + simgvSelect('sti-size', model.sizes.values, f.size) + '</div>');
  }
  return cells.length ? '<div class="st-row2">' + cells.join('') + '</div>' : '';
}

function simgvModelField(IM, model) {
  if (IM.catLoading && !model) return '<div><div class="st-lbl">Model</div><div class="st-model">Loading models…</div></div>';
  if (!model) {
    return '<div><div class="st-lbl">Model</div><button class="st-model" ' + SIMGV_A('pop:model') + '>'
      + '<span class="st-sp"><span class="st-mname">No model yet</span><span class="st-mmeta">' + esc((IM.catErr && IM.catErr.message) || 'Pick one to start') + '</span></span>' + ic('chevD') + '</button></div>';
  }
  const where = model.group === 'local'
    ? '<span class="st-tag local">' + ic('cpu') + 'Local</span>'
    : '<span class="st-tag cloud">' + ic('cloud') + 'Cloud</span>';
  return '<div><div class="st-lbl">Model</div><button class="st-model' + (IM.pop === 'model' ? ' open' : '') + '" ' + SIMGV_A('pop:model') + ' aria-haspopup="listbox" aria-expanded="' + (IM.pop === 'model') + '">'
    + simgvLogo(model)
    + '<span class="st-sp"><span class="st-mname">' + esc(model.name) + '</span><span class="st-mmeta">' + esc(simgModelMeta(model)) + '</span></span>'
    + simgModelTags(model).map(simgvTag).join('') + where + ic('chevD') + '</button></div>';
}

function simgvSlider(id, label, spec, v) {
  if (!spec) return '';
  const val = v === null || v === undefined ? spec.default : v;
  return '<label class="st-slider"><span class="t">' + esc(label) + '</span>'
    + '<input type="range" id="' + id + '" min="' + spec.min + '" max="' + spec.max + '" step="' + (spec.step || 1) + '" value="' + esc(val) + '">'
    + '<span class="v mono" data-val="' + id + '">' + esc(val) + '</span></label>';
}

function simgvAdvanced(IM, model) {
  if (!model) return '';
  const f = IM.form;
  const has = model.negativePrompt || model.seed || model.steps || model.cfg || model.guidance || (model.strength && f.mode !== 'create');
  if (!has) return '';
  const head = '<button class="st-fold-h" ' + SIMGV_A('adv') + ' aria-expanded="' + !!IM.adv + '">' + ic('sliders') + 'Advanced<span class="st-sp"></span>'
    + (!IM.adv && f.seedLocked && f.seed !== '' ? '<span class="mono st-dim">seed ' + esc(f.seed) + '</span>' : '')
    + ic(IM.adv ? 'chevU' : 'chevD') + '</button>';
  if (!IM.adv) return '<div class="st-fold">' + head + '</div>';
  const body = []
  if (model.negativePrompt) {
    body.push('<div><label class="st-lbl" for="sti-neg">Leave out <span class="r">negative prompt</span></label>'
      + '<input class="st-inp" id="sti-neg" placeholder="text, watermark, blurry" value="' + esc(f.negative || '') + '"></div>');
  }
  body.push(simgvSlider('sti-steps', 'Steps', model.steps, f.steps));
  body.push(simgvSlider('sti-cfg', 'CFG', model.cfg, f.cfg));
  body.push(simgvSlider('sti-guid', 'Guidance', model.guidance, f.guidance));
  if (f.mode !== 'create') body.push(simgvSlider('sti-str', 'Strength', model.strength, f.strength));
  if (model.seed) {
    body.push('<div><div class="st-lbl">Seed</div><div class="st-seedrow">'
      + '<input class="st-inp mono" id="sti-seed" inputmode="numeric" placeholder="random" value="' + esc(f.seedLocked ? f.seed : '') + '">'
      + '<button class="st-lock' + (f.seedLocked ? ' on' : '') + '" ' + SIMGV_A('seedlock') + ' title="' + (f.seedLocked ? 'Use a new seed every time' : 'Keep the same seed') + '" aria-pressed="' + !!f.seedLocked + '">' + ic('lock') + '</button>'
      + '<button class="st-lock" ' + SIMGV_A('seednew') + ' title="New seed" aria-label="New seed">' + ic('refresh') + '</button></div></div>');
  }
  if (model.group === 'cloud' && !(model.steps || model.cfg || model.guidance)) body.push('<div class="st-na">Cloud models pick their own steps and guidance.</div>');
  return '<div class="st-fold">' + head + '<div class="st-fold-b">' + body.join('') + '</div></div>';
}

function simgvForm(IM) {
  const model = IM.model;
  const f = IM.form;
  const tabs = simgModeTabs(model, IM.catalog);
  // A click on a greyed mode (IM.modeWhy) puts its reason in the hint line; else the mode's hint and what is greyed.
  const whyTab = tabs.find((t) => t.id === IM.modeWhy && !t.ok);
  const offIds = whyTab ? [whyTab.id] : tabs.filter((t) => !t.ok && t.need !== 'pick').map((t) => t.id);
  const note = whyTab ? simgModeWhy(whyTab, model) : simgModeNote(tabs, model);
  const pick = note && model && simgOtherCan(IM.catalog, model, offIds)
    ? ' <button class="st-link" ' + SIMGV_A('pop:model') + '>' + (whyTab ? 'Pick a model that can' : 'Pick one') + '</button>.' : '';
  const parts = [];
  parts.push('<div><label class="st-lbl" for="sti-prompt">Prompt' + (f.mode === 'upscale' ? ' <span class="r">optional</span>' : '') + '</label>'
    + '<textarea class="st-ta" id="sti-prompt" rows="4" placeholder="Describe the picture. Subject, place, light, style.">' + esc(f.prompt || '') + '</textarea>'
    // ATO-809: Improve prompt (studio/improve-prompt.js) and the last prompts sent from this page (studio/recent-prompts.js).
    + (typeof studioRecentHTML === 'function' ? studioRecentHTML(IM.recent, IM.recentOpen, (v, a) => SIMGV_A(a ? v + ':' + a : v),
      typeof studioImproveHTML === 'function' ? studioImproveHTML(f.prompt, IM.improve, (v) => SIMGV_A(v)) : '') : '') + '</div>');
  parts.push('<div><div class="st-lbl">Mode</div><div class="st-modes" role="tablist">'
    + tabs.map((t) => '<button class="st-mode' + (f.mode === t.id ? ' on' : '') + (t.ok ? '' : ' off') + '" role="tab" aria-selected="' + (f.mode === t.id) + '" '
      + SIMGV_A((t.ok ? 'mode:' : 'modewhy:') + t.id) + (t.ok ? '' : ' aria-disabled="true"') + (t.why ? ' title="' + esc(t.why) + '"' : '') + '>' + esc(t.label) + '</button>').join('')
    + '</div>'
    + '<div class="st-hint" role="status">' + ic('info') + '<span>' + (whyTab ? '' : esc(SIMG_MODE_HINT[f.mode] || '') + (note ? ' ' : ''))
      + esc(note) + pick + '</span></div></div>');
  if (f.mode !== 'create') {
    parts.push('<div><div class="st-lbl">' + (f.mode === 'reference' ? 'Main reference' : 'Source image') + ' <span class="r">drop or paste</span></div>'
      + simgvSource(IM, 'source', 'Add a picture', 'PNG, JPEG or WebP') + '</div>');
  }
  if (f.mode === 'reference') parts.push(simgvRefs(IM, model));
  if (f.mode === 'inpaint' || f.mode === 'extend') {
    parts.push('<div><div class="st-lbl">Mask <span class="r">white = redraw</span></div>'
      + simgvSource(IM, 'mask', 'Add a mask', 'Same size as the source. White areas get redrawn.') + '</div>');
  }
  if (f.mode !== 'upscale') parts.push(simgvAspects(IM, model));
  parts.push(simgvCountRow(IM, model));
  parts.push(simgvModelField(IM, model));
  parts.push(simgvAdvanced(IM, model));
  return '<div class="st-form-scroll">' + parts.join('') + '</div><div class="st-foot" data-foot>' + simgvFoot(IM) + '</div>';
}

function simgvFoot(IM) {
  const model = IM.model;
  const live = IM.job && (IM.job.state === 'queued' || IM.job.state === 'generating');
  const lines = [];
  if (model && model.group === 'cloud' && IM.catalog && IM.catalog.cloud && IM.catalog.cloud.keyMissing) {
    lines.push('<div class="st-est warn">' + ic('key') + '<span>Cloud models need an OpenRouter key. <button class="st-link" ' + SIMGV_A('settings') + '>Add a key</button></span></div>');
  } else if (model && model.group === 'local') {
    lines.push('<div class="st-est">' + ic('cpu') + '<span><b>Free</b> · runs on this Mac' + (model.local && !model.local.loaded ? ' · load the model first' : '') + '</span></div>');
  } else if (model && model.group === 'cloud') {
    lines.push('<div class="st-est">' + ic('cloud') + '<span>Charged to your OpenRouter key</span></div>');
  }
  if (IM.formMsg) lines.push('<div class="st-est warn" role="status">' + ic('info') + '<span>' + esc(IM.formMsg) + '</span></div>');
  const btn = live
    ? '<button class="st-go stop" ' + SIMGV_A('stop') + '>' + ic('x') + 'Stop</button>'
    : '<button class="st-go" ' + SIMGV_A('generate') + (IM.starting || !model ? ' disabled' : '') + '>' + ic('wand')
      + esc(IM.starting ? 'Starting…' : simgGenerateLabel(IM.price)) + '<kbd>⌘ ↵</kbd></button>';
  return lines.join('') + btn;
}

/* ---------- model picker ---------- */

function simgvPop(IM) {
  if (IM.pop !== 'model') return '';
  const q = String(IM.modelQ || '').trim().toLowerCase();
  const all = simgModels(IM.catalog).filter((m) => !q || (m.name + ' ' + m.id).toLowerCase().includes(q));
  const row = (m) => {
    const on = IM.model && IM.model.id === m.id && IM.model.provider === m.provider;
    const chips = m.group === 'local' ? simgLocalChips(m).map((c) => c.cls ? simgvTag(c) : '<span>' + esc(c.text) + '</span>').join('')
      : '<span>' + esc(m.description || simgModesLine(m)) + '</span>';
    return '<button class="st-opt' + (on ? ' on' : '') + (m.group === 'local' && !(m.local && m.local.loaded) ? ' dim' : '') + '" role="option" aria-selected="' + on + '" '
      + SIMGV_A('model:' + m.provider + '|' + m.id) + '>' + simgvLogo(m)
      + '<span class="st-sp"><span class="st-mname">' + esc(m.name) + (m.default ? ' <span class="st-tag soft">Default</span>' : '')
      + simgModelTags(m).map(simgvTag).join('') + '</span><span class="st-mmeta">' + chips + '</span></span></button>';
  };
  const cloud = all.filter((m) => m.group === 'cloud'), local = all.filter((m) => m.group === 'local');
  const err = (sec) => sec && sec.error ? '<div class="st-pop-err">' + esc(sec.error.message) + '</div>' : '';
  return '<div class="st-pop" role="dialog" aria-label="Image models">'
    + '<label class="st-pop-s">' + ic('search') + '<input id="sti-mq" placeholder="Search image models" value="' + esc(IM.modelQ || '') + '" autocomplete="off"></label>'
    + '<div class="st-pop-g">' + ic('cloud') + 'Cloud · OpenRouter</div>' + err(IM.catalog && IM.catalog.cloud)
    + (cloud.length ? cloud.map(row).join('') : '<div class="st-pop-none">No cloud models' + (q ? ' match' : '') + '</div>')
    + '<div class="st-pop-g">' + ic('cpu') + 'On this Mac · free, private</div>' + err(IM.catalog && IM.catalog.local)
    + (local.length ? local.map(row).join('') : '<div class="st-pop-none">No local models' + (q ? ' match' : ' yet') + '</div>')
    + '</div>';
}

/* ---------- stage ---------- */

function simgvEmpty() {
  return '<div class="st-empty"><div class="st-big">' + ic('image') + '</div><h3>Your images show up here</h3>'
    + '<p>Write what you want to see, pick a model and press Generate. Everything is saved to your images folder.</p>'
    + '<div class="st-ideas">' + SIMGV_IDEAS.map((t) => '<button class="st-idea" ' + SIMGV_A('idea:' + t) + '>' + esc(t) + '</button>').join('') + '</div></div>';
}

function simgvProgress(IM) {
  const job = IM.job;
  const p = simgProgress(job);
  const model = simgFindModel(IM.catalog, job.model) || {name: job.model};
  const phases = simgPhaseRows(p.phaseIndex);
  const batch = (job.progress && job.progress.batchSize) || IM.jobCount || 1;
  return '<div class="st-prog" data-prog="' + esc(job.id) + '">'
    + '<div class="st-prog-h"><div class="st-spin"></div><div><div class="t" data-p="title">' + esc(p.title) + '</div>'
      + '<div class="s">' + esc(model.name + ' · ' + (job.cloud ? 'in the cloud' : 'on this Mac')) + '</div></div></div>'
    + '<div class="st-bar"><i data-p="bar" style="width:' + Math.round(p.fraction * 100) + '%"></i></div>'
    + '<div class="st-prog-m"><span data-p="line">' + esc(p.line) + '</span><span class="mono" data-p="eta">' + esc(p.eta) + '</span></div>'
    + '<div class="st-phases" data-p="phases">' + phases + '</div>'
    + (batch > 1 ? '<div class="st-minis">' + Array.from({length: Math.min(batch, 8)}, () => '<div class="st-th ghost"></div>').join('') + '</div>' : '')
    + '<div class="st-prog-f"><span class="st-dim">You can leave this page. It keeps going.</span><span class="st-sp"></span>'
      + '<button class="btn st-danger" ' + SIMGV_A('stop') + '>' + ic('x') + 'Stop</button></div></div>';
}

function simgPhaseRows(at) {
  return SIMG_PHASE_ORDER.map(([, label], i) => {
    const cls = at < 0 ? '' : i < at ? ' done' : i === at ? ' now' : '';
    return '<div class="st-ph' + cls + '"><span class="c">' + (cls === ' done' ? ic('check') : '') + '</span>' + esc(label) + '</div>';
  }).join('');
}

/* ATO-830: OpenRouter's upstream for a model (often Google's, for Nano Banana)
   answers 429 when it is out of quota. Core passes it on as
   REMOTE_RATE_LIMITED, or as its own words ("openrouter is rate-limiting
   requests") on a job that failed after it started. */
const SIMG_NOT_RATE = /^(NO_KEY|JOB_BUSY|GPU_BUSY|MODEL_|SIDE_FILE_|OUT_OF_MEMORY|QUEUE_FULL|DISK_|CORE_|INVALID_|UNKNOWN_MODEL|ENGINE_|DOWNLOAD_FAILED|CANCELLED|OUTSIDE|UNSUPPORTED_WORKFLOW|REMOTE_(?!RATE_LIMITED$|UNAVAILABLE$))/;
function simgRateLimited(e) {
  if (!e) return false;
  if (e.code === 'REMOTE_RATE_LIMITED') return true;
  /* The words only on a code that does not already say what went wrong: a
     size of 429 or a quota message is not a rate limit. A bare 429 counts
     only beside the words that make it a status. */
  if (SIMG_NOT_RATE.test(String(e.code || ''))) return false;
  const msg = String(e.message || '');
  return /rate[ -]?limit|too many requests/i.test(msg) || (/\b429\b/.test(msg) && /http|status|upstream|answered|returned/i.test(msg));
}

/* Another cloud model to offer when one is rate limited: never the one that
   failed, one that runs the current mode, a GPT Image model first (it has a
   different upstream), else the catalog's next. `models` is simgModels(). */
function simgAltModel(models, failed, mode) {
  const f = failed || {};
  const ok = (models || []).filter((m) => m.group === 'cloud' && !(m.id === f.id && (!f.provider || m.provider === f.provider))
    && (!mode || (m.modes || []).includes(mode)));
  return ok.find((m) => /gpt[ -]?image/i.test(m.id + ' ' + (m.name || ''))) || ok[0] || null;
}

/* The rate-limit card's words: which model's provider is busy, and that a
   turned-away request is not billed. Not "nothing was charged": a job of
   several images can be refused after some of them were made. */
function simgRateLimitLine(name) {
  return 'OpenRouter\u2019s provider for ' + (name || 'this model') + ' is busy right now. OpenRouter does not charge for a request it turned away. Try again in a moment, or use another model.';
}

function simgvError(IM) {
  const e = IM.jobErr || {};
  // A local job never went to OpenRouter, whatever its words say.
  if (simgRateLimited(e) && (IM.lastReq || {}).provider !== 'local') return simgvRateLimited(IM);
  const key = e.code === 'NO_KEY';
  const core = /^CORE_/.test(e.code || '');
  return '<div class="st-prog st-err" role="alert"><div class="st-prog-h"><div class="st-erri">' + ic('alert') + '</div>'
    + '<div><div class="t">' + esc(key ? 'Add an OpenRouter key' : 'That did not work') + '</div><div class="s">' + esc(e.message || 'Something went wrong.') + '</div></div></div>'
    + '<div class="st-prog-f"><span class="st-sp"></span>'
    + (key ? '<button class="btn" ' + SIMGV_A('settings') + '>' + ic('key') + 'Open Settings</button>' : '')
    + (core ? '<button class="btn" ' + SIMGV_A('retry') + '>' + ic('retry') + 'Try again</button>' : '')
    + '<button class="btn" ' + SIMGV_A('dismiss') + '>Close</button></div></div>';
}

function simgvRateLimited(IM) {
  const req = IM.lastReq || {};
  const failed = {id: req.model || (IM.job && IM.job.model), provider: req.provider};
  const models = simgModels(IM.catalog);
  const was = models.find((m) => m.id === failed.id) || {name: failed.id};
  const alt = simgAltModel(models, failed, IM.form && IM.form.mode);
  return '<div class="st-prog st-err" role="alert"><div class="st-prog-h"><div class="st-erri">' + ic('alert') + '</div>'
    + '<div><div class="t">' + esc((was.name || 'This model') + ' is busy') + '</div><div class="s">' + esc(simgRateLimitLine(was.name)) + '</div></div></div>'
    + '<div class="st-prog-f"><span class="st-sp"></span>'
    + '<button class="btn" ' + SIMGV_A('retry') + '>' + ic('retry') + 'Retry</button>'
    + (alt ? '<button class="btn" ' + SIMGV_A('trymodel:' + alt.provider + '|' + alt.id) + '>Try ' + esc(alt.name || alt.id) + '</button>' : '')
    + '<button class="btn" ' + SIMGV_A('dismiss') + '>Close</button></div></div>';
}

function simgvAgo(ms) {
  const s = Math.max(0, (Date.now() - Number(ms || 0)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return new Date(Number(ms)).toLocaleDateString();
}

function simgvRecipe(item) {
  const r = simgRecipeToForm(item);
  const kv = [['Model', (item.model && item.model.name) || r.modelId || '']];
  if (r.mode) kv.push(['Mode', (SIMG_MODES.find(([id]) => id === r.mode) || [, r.mode])[1]]);
  if (item.width && item.height) kv.push(['Size', item.width + ' × ' + item.height]);
  if (r.aspect) kv.push(['Shape', r.aspect]);
  if (r.resolution) kv.push(['Quality', r.resolution]);
  if (r.seed !== undefined) kv.push(['Seed', String(r.seed)]);
  if (r.steps) kv.push(['Steps', String(r.steps)]);
  return '<div class="st-recipe"><h5>How this was made</h5><div class="p">' + esc(item.prompt || r.prompt || 'No prompt') + '</div>'
    + '<div class="st-kv">' + kv.map(([k, v]) => '<span>' + esc(k) + '</span><b>' + esc(v) + '</b>').join('') + '</div></div>';
}

/** A picture opened from a chat that Studio did not make: no recipe, pin or delete. */
function simgvFromChat(item) {
  const name = String(item.path).split(/[\\/]/).pop() || item.path;
  return '<div class="st-vbar"><span class="st-glass">From chat</span><span class="st-glass st-name" title="' + esc(item.path) + '">' + esc(name) + '</span><span class="st-sp"></span></div>'
    + '<div class="st-shot" data-pic="' + esc(item.path) + '" data-full="1"></div>'
    + '<div class="st-actions">'
      + '<button ' + SIMGV_A('saveas') + '>' + ic('download') + 'Save as…</button>'
      + '<button ' + SIMGV_A('reveal') + '>' + ic('folder') + 'Show in Finder</button>'
      + '<button ' + SIMGV_A('copy') + '>' + ic('copy') + 'Copy</button>'
      + '<span class="sep"></span>'
      + '<button class="pri" ' + SIMGV_A('tochat') + '>' + ic('chat') + 'Send to chat</button>'
    + '</div>';
}

function simgvResult(IM, item) {
  if (item.fromChat) return simgvFromChat(item);
  const group = IM.items.filter((x) => simgJobOf(x.id) === simgJobOf(item.id));
  const n = group.findIndex((x) => x.id === item.id) + 1;
  const pos = group.length > 1 ? n + ' of ' + group.length + ' · ' : '';
  const del = IM.delArmed === item.id;
  return '<div class="st-vbar"><span class="st-glass">' + esc(pos + simgvAgo(item.createdAtMs)) + '</span><span class="st-sp"></span>'
    + '<button class="st-glass' + (IM.recipe ? ' on' : '') + '" ' + SIMGV_A('recipe') + ' aria-pressed="' + !!IM.recipe + '">' + ic('info') + 'Recipe</button>'
    + '<button class="st-glass ic' + (item.pinned ? ' on' : '') + '" ' + SIMGV_A('pin') + ' title="' + (item.pinned ? 'Unpin' : 'Pin') + '" aria-pressed="' + !!item.pinned + '">' + ic('pin') + '</button>'
    + '<button class="st-glass' + (del ? ' danger' : ' ic') + '" ' + SIMGV_A('delete') + ' title="Delete from disk">' + ic('trash') + (del ? 'Delete for good?' : '') + '</button></div>'
    + '<div class="st-shot" data-pic="' + esc(item.path) + '" data-full="1"' + (item.width && item.height ? ' style="aspect-ratio:' + item.width + ' / ' + item.height + '"' : '') + '></div>'
    + (IM.recipe ? simgvRecipe(item) : '')
    + '<div class="st-actions">'
      + '<button ' + SIMGV_A('saveas') + '>' + ic('download') + 'Save as…</button>'
      + '<button ' + SIMGV_A('reveal') + '>' + ic('folder') + 'Show in Finder</button>'
      + '<button ' + SIMGV_A('copy') + '>' + ic('copy') + 'Copy</button>'
      + '<span class="sep"></span>'
      + '<button ' + SIMGV_A('usesource') + '>' + ic('swap') + 'Use as source</button>'
      + '<button ' + SIMGV_A('restore') + '>' + ic('undo') + 'Restore these settings</button>'
      + '<button class="pri" ' + SIMGV_A('tochat') + '>' + ic('chat') + 'Send to chat</button>'
    + '</div>';
}

/** `<jobId>-<NN>` → `<jobId>`. */
function simgJobOf(id) { return String(id || '').replace(/-\d+$/, ''); }

function simgvStage(IM) {
  const live = IM.job && (IM.job.state === 'queued' || IM.job.state === 'generating');
  const item = IM.sel ? IM.items.find((x) => x.id === IM.sel) || (IM.pinnedMore || []).find((x) => x.id === IM.sel) || (IM.chatItem && IM.chatItem.id === IM.sel ? IM.chatItem : null) : null;
  if (live) return '<div class="st-viewer grid">' + (IM.form.source ? '<div class="st-blurbg" data-pic="' + esc(IM.form.source.key) + '"></div>' : '') + simgvProgress(IM) + '</div>';
  if (IM.jobErr) return '<div class="st-viewer grid">' + simgvError(IM) + '</div>';
  if (item) return '<div class="st-viewer well">' + simgvResult(IM, item) + '</div>';
  return '<div class="st-viewer grid">' + simgvEmpty() + '</div>';
}

function simgvGallery(IM) {
  const pinned = simgPinnedList(IM.items, IM.pinnedMore);
  const list = IM.filter === 'pinned' ? pinned : IM.items;
  const live = IM.job && (IM.job.state === 'queued' || IM.job.state === 'generating');
  const ghosts = live && IM.filter !== 'pinned' ? Math.min(IM.jobCount || 1, 8) : 0;
  const count = IM.galLoading && !IM.items.length ? 'loading' : IM.total ? IM.total + (IM.total === 1 ? ' image' : ' images') : 'empty';
  const head = '<div class="st-gal-h"><h4>Gallery</h4><span class="ct">' + esc(count) + '</span><span class="st-sp"></span>'
    + (IM.picking ? '<span class="st-pickhint">Click a picture to use it</span><button class="st-link" ' + SIMGV_A('fromlib:') + '>Cancel</button>' : '')
    + '<div class="st-seg"><button class="' + (IM.filter === 'all' ? 'on' : '') + '" ' + SIMGV_A('filter:all') + '>All</button>'
    + '<button class="' + (IM.filter === 'pinned' ? 'on' : '') + '" ' + SIMGV_A('filter:pinned') + '>Pinned' + (pinned.length ? ' · ' + pinned.length : '') + '</button></div></div>';
  if (!list.length && !ghosts) {
    return head + '<div class="st-galempty">' + ic(IM.filter === 'pinned' ? 'pin' : 'image')
      + esc(IM.galErr ? IM.galErr.message : IM.filter === 'pinned' ? (IM.pinnedLoading ? 'Looking for pinned images…' : IM.pinnedPartial ? 'Nothing pinned among the newest images. Load more under All to find older ones.' : 'Nothing pinned yet.') : 'Nothing yet. Images you make here and in chats land in one place.') + '</div>';
  }
  return head + '<div class="st-thumbs' + (IM.picking ? ' picking' : '') + '">'
    + Array.from({length: ghosts}, () => '<div class="st-th ghost shim"></div>').join('')
    + list.map((x) => '<button class="st-th' + (x.id === IM.sel ? ' on' : '') + '" ' + SIMGV_A('sel:' + x.id) + ' title="' + esc(x.prompt || '') + '"'
      + ' data-pic="' + esc(x.thumbnailPath || x.path) + '" data-id="' + esc(x.id) + '">'
      + (x.pinned ? '<span class="st-pin">' + ic('pin') + '</span>' : '') + '</button>').join('')
    + '</div>'
    + (IM.hasMore && IM.filter === 'all' ? '<button class="loadmore" ' + SIMGV_A('more') + '>Load more</button>' : '')
    + (IM.filter === 'pinned' && IM.pinnedPartial && !IM.pinnedLoading ? '<div class="st-galempty">' + esc('Older pinned images may be missing here. Load more under All to find them.') + '</div>' : '');
}

function simgvPage(IM) {
  return simgvTop(IM)
    + '<div class="st-cols">'
      + '<div class="st-form" data-part="form">' + simgvForm(IM) + '</div>'
      + '<div class="st-popwrap" data-part="pop">' + simgvPop(IM) + '</div>'
      + '<div class="st-stage"><div class="st-viewwrap" data-part="stage">' + simgvStage(IM) + '</div>'
        + '<div class="st-gal" data-part="gallery">' + simgvGallery(IM) + '</div></div>'
    + '</div>';
}

if (typeof module !== 'undefined') module.exports = {simgJobOf, simgRateLimited, simgAltModel, simgRateLimitLine};
