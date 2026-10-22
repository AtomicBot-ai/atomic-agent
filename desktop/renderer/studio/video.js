/* ---------------- Studio › Video ----------------
   The Video page of Studio: a form (prompt, start from text or a first frame,
   length, resolution, shape, sound, model), the line under it (price for a
   cloud model, time and memory for one on this Mac), Generate, progress with
   Stop, the result player and the clip gallery.

   Loaded as a plain script after the Studio shell (studio/shell.js) or before
   it: registration waits until `window.STUDIO` exists. Talks to main only
   through `BR.studio` (`window.atomic.studio`, studio/CONTRACT.md). Clicks are
   handled by delegation on the page's own root with `data-vact`, never through
   renderer.js act(), so the page and the shell stay independent.

   Owner decisions (21.10): no spend counter; the price shows only on the
   Generate button and only when it is known; no confirm dialog (the button is
   the confirmation); a cloud clip says "Stop doesn't cancel the charge";
   default length 4 s, the cheapest; models with a non-commercial license or
   adult content are listed with a label, never hidden.

   The pure helpers at the top (request mapping, length/shape options, the
   estimate and price wording) are exported on `window.StudioVideo` and, under
   Node, on module.exports, for test/studio-video.test.mjs. */
(function (g) {
  'use strict';

  const KIND = 'video';
  const STORE_KEY = 'atomic.studio.video.form.v1';
  const DEFAULT_SECS = 4;
  const SHAPES = ['16:9', '9:16'];
  const LENGTH_PICKS = [2, 3, 4, 5, 6, 8, 10, 12, 15, 20];

  /* ============================================================
     pure helpers
     ============================================================ */

  const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (n) => (typeof g.ic === 'function' ? g.ic(n) : '');
  const isLocal = (m) => !!m && m.provider === 'local';

  /** Length chips (seconds) a model offers: its own list, or picks inside its range. */
  function durationOptions(model) {
    const d = model && model.durations;
    if (!d) return [];
    if (Array.isArray(d.values) && d.values.length) {
      return Array.from(new Set(d.values.filter((x) => typeof x === 'number' && x > 0))).sort((a, b) => a - b);
    }
    const min = typeof d.min === 'number' ? d.min : null;
    const max = typeof d.max === 'number' ? d.max : null;
    if (min === null && max === null) return typeof d.default === 'number' ? [d.default] : [];
    const lo = min === null ? 1 : min, hi = max === null ? Math.max(lo, 10) : max;
    const out = LENGTH_PICKS.filter((x) => x >= lo && x <= hi);
    if (min !== null) out.push(min);
    if (max !== null) out.push(max);
    return Array.from(new Set(out)).sort((a, b) => a - b);
  }

  /** The length to select: keep the last one when the model offers it, else 4 s, else the shortest. */
  function pickDuration(model, prev) {
    const opts = durationOptions(model);
    if (!opts.length) return null;
    if (typeof prev === 'number' && opts.includes(prev)) return prev;
    if (opts.includes(DEFAULT_SECS)) return DEFAULT_SECS;
    return opts[0];
  }

  /** Shape chips: 16:9 and 9:16 where the model has them. Local models size by width and height, so both. */
  function aspectOptions(model) {
    if (!model) return [];
    if (isLocal(model)) return model.sizes && model.sizes.kind === 'range' ? SHAPES.slice() : [];
    const values = (model.aspectRatios && Array.isArray(model.aspectRatios.values)) ? model.aspectRatios.values : [];
    const both = SHAPES.filter((s) => values.includes(s));
    return both.length ? both : values.slice(0, 4);
  }

  function pickAspect(model, prev) {
    const opts = aspectOptions(model);
    if (!opts.length) return null;
    if (prev && opts.includes(prev)) return prev;
    const def = model.aspectRatios && model.aspectRatios.default;
    return def && opts.includes(def) ? def : opts[0];
  }

  function resolutionOptions(model) {
    return (model && model.resolutions && Array.isArray(model.resolutions.values)) ? model.resolutions.values.slice() : [];
  }

  function pickResolution(model, prev) {
    const opts = resolutionOptions(model);
    if (!opts.length) return null;
    if (prev && opts.includes(prev)) return prev;
    const def = model.resolutions.default;
    return def && opts.includes(def) ? def : opts[0];
  }

  /** A first frame works only with cloud models that list the image-to-video mode. Local is "Soon". */
  function supportsImageStart(model) {
    return !!model && !isLocal(model) && Array.isArray(model.modes) && model.modes.includes('image-to-video');
  }

  /** Width and height for a local model in the chosen shape: its default size, turned for 9:16. */
  function localDims(model, aspect) {
    const s = model && model.sizes;
    if (!s || s.kind !== 'range' || !s.defaultWidth || !s.defaultHeight) return null;
    const long = Math.max(s.defaultWidth, s.defaultHeight), short = Math.min(s.defaultWidth, s.defaultHeight);
    return aspect === '9:16' ? { width: short, height: long } : { width: long, height: short };
  }

  /** The form as a VideoRequest (studio/CONTRACT.md): only what this model takes. */
  function buildRequest(form, model) {
    if (!model) return null;
    const local = isLocal(model);
    const imageStart = form.mode === 'image' && supportsImageStart(model);
    const req = {
      provider: local ? 'local' : 'openrouter',
      model: model.id,
      mode: imageStart ? 'image-to-video' : 'create',
      prompt: String(form.prompt || '').trim(),
    };
    const neg = String(form.negativePrompt || '').trim();
    if (model.negativePrompt && neg) req.negativePrompt = neg;
    const secs = durationOptions(model).includes(form.durationSecs) ? form.durationSecs : pickDuration(model, null);
    if (secs !== null && !local) req.durationSecs = secs;
    const aspect = aspectOptions(model).includes(form.aspectRatio) ? form.aspectRatio : pickAspect(model, null);
    if (local) {
      const dims = localDims(model, aspect);
      if (dims) { req.width = dims.width; req.height = dims.height; }
    } else {
      if (aspect) req.aspectRatio = aspect;
      const res = resolutionOptions(model).includes(form.resolution) ? form.resolution : pickResolution(model, null);
      if (res) req.resolution = res;
      if (model.audio && typeof form.audio === 'boolean') req.audio = form.audio;
    }
    if (imageStart && form.firstFrame) {
      req.firstFrame = form.firstFrame.path ? { path: form.firstFrame.path } : { base64: form.firstFrame.base64 };
    }
    return req;
  }

  /** Why Generate cannot run yet, in plain words ('' when it can). */
  function blockReason(form, model) {
    if (!model) return 'Pick a model first.';
    if (form.mode === 'image') {
      if (isLocal(model)) return 'Starting from an image on this Mac is coming soon. Pick a cloud model.';
      if (!supportsImageStart(model)) return 'This model starts from text only.';
      if (!form.firstFrame) return 'Add a first frame.';
      return '';
    }
    if (!String(form.prompt || '').trim()) return 'Write a prompt first.';
    return '';
  }

  /** PriceParams for BR.studio.price. */
  function priceParams(req) {
    if (!req) return null;
    const p = { kind: KIND };
    if (req.durationSecs) p.durationSecs = req.durationSecs;
    if (req.resolution) p.resolution = req.resolution;
    if (typeof req.audio === 'boolean') p.audio = req.audio;
    if (req.mode) p.mode = req.mode;
    return p;
  }

  function money(n) { return '$' + (Math.round(n * 100) / 100).toFixed(2); }

  /** "≈ $0.60", "≈ $0.32–0.40", or '' when the price is not known. */
  function priceLabel(price) {
    if (!price || typeof price.usd !== 'number' || !Number.isFinite(price.usd)) return '';
    if (typeof price.maxUsd === 'number' && Number.isFinite(price.maxUsd) && price.maxUsd > price.usd + 0.004) {
      return '≈ ' + money(price.usd) + '–' + money(price.maxUsd).slice(1);
    }
    return '≈ ' + money(price.usd);
  }

  /** The Generate button's words. */
  function generateLabel(o) {
    if (o && o.armed) return 'Generate anyway';
    const p = o && !o.local ? priceLabel(o.price) : '';
    return p ? 'Generate · ' + p : 'Generate';
  }

  /** "~40 s", "~4–7 min", "~1–2 h" for a span of seconds. */
  function spanText(low, high) {
    const lo = Math.max(0, Number(low) || 0), hi = Math.max(lo, Number(high) || lo);
    const fmt = (a, b, unit) => (a === b ? '~' + a + ' ' + unit : '~' + a + '–' + b + ' ' + unit);
    if (hi < 90) return fmt(Math.max(1, Math.round(lo)), Math.max(1, Math.round(hi)), 's');
    if (hi < 90 * 60) return fmt(Math.max(1, Math.round(lo / 60)), Math.max(1, Math.round(hi / 60)), 'min');
    return fmt(Math.max(1, Math.round(lo / 3600)), Math.max(1, Math.round(hi / 3600)), 'h');
  }

  /** A VideoEstimate in words: { level, text, warn }. warn is the inline warning that arms "Generate anyway". */
  function estimateVerdict(est) {
    if (!est || !est.memory) return { level: 'unknown', text: '', warn: '' };
    const v = est.memory.verdict;
    const time = est.seconds ? 'takes ' + spanText(est.seconds.low, est.seconds.high) : '';
    const join = (a, b) => [a, b].filter(Boolean).join(' · ');
    if (v === 'fits') return { level: 'fits', text: join(time, 'fits in memory'), warn: '' };
    if (v === 'tight') return { level: 'tight', text: join(time, 'tight on memory, close other apps'), warn: '' };
    if (v === 'exceeds') return { level: 'exceeds', text: join(time, "doesn't fit in memory"), warn: 'Will swap, may take hours' };
    return { level: 'unknown', text: time, warn: '' };
  }

  function fitChip(est) {
    const v = est && est.memory && est.memory.verdict;
    if (v === 'fits') return { cls: 'ok', text: 'Fits' };
    if (v === 'tight') return { cls: 'tight', text: 'Tight' };
    if (v === 'exceeds') return { cls: 'bad', text: 'Too big' };
    return null;
  }

  function gbText(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '';
    const gb = n / (1024 ** 3);
    return (gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10) + ' GB';
  }

  /** Labels shown next to a model: content flags and what it can do. */
  function modelLabels(model, mode) {
    const out = [];
    if (!model) return out;
    if (model.default) out.push({ cls: 'soft', text: 'Default' });
    if (model.nonCommercial) out.push({ cls: 'warn', text: 'Non-commercial' });
    if (model.adult) out.push({ cls: 'warn', text: '18+' });
    if (isLocal(model)) {
      if (mode === 'image') out.push({ cls: 'soft', text: 'Image start: Soon' });
      if (model.local && !model.local.loaded) out.push({ cls: 'soft', text: 'Not loaded' });
    } else {
      if (model.audio) out.push({ cls: 'soft', text: 'Sound' });
      if (supportsImageStart(model)) out.push({ cls: 'soft', text: 'First frame' });
    }
    return out;
  }

  const PHASES_CLOUD = [['queued', 'In the queue'], ['sampling', 'Rendering'], ['saving', 'Saving the clip']];
  const PHASES_LOCAL = [['queued', 'In the queue'], ['encoding', 'Reading the prompt'], ['sampling', 'Drawing frames'], ['decoding', 'Decoding frames'], ['postprocessing', 'Writing the video'], ['saving', 'Saving the clip']];

  /** The phase list for a job, each marked done / now / next. */
  function phaseList(job) {
    const list = job && job.cloud ? PHASES_CLOUD : PHASES_LOCAL;
    let cur = job && job.progress ? job.progress.phase : (job && job.state === 'queued' ? 'queued' : '');
    if (job && job.cloud && (cur === 'encoding' || cur === 'decoding' || cur === 'postprocessing')) cur = cur === 'encoding' ? 'queued' : 'saving';
    const idx = list.findIndex((p) => p[0] === cur);
    return list.map((p, i) => ({ key: p[0], text: p[1], status: idx < 0 ? (i === 0 ? 'now' : 'next') : i < idx ? 'done' : i === idx ? 'now' : 'next' }));
  }

  function etaText(sec) {
    if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) return '';
    if (sec < 5) return 'almost done';
    if (sec < 90) return 'about ' + Math.round(sec / 5) * 5 + ' s left';
    if (sec < 90 * 60) return 'about ' + Math.round(sec / 60) + ' min left';
    return 'about ' + Math.round(sec / 360) / 10 + ' h left';
  }

  /** "Drawing frames · step 12 of 30" for local sampling. */
  function stepText(job) {
    const p = job && job.progress;
    if (!p || job.cloud || !(p.totalSteps > 0)) return '';
    return 'step ' + Math.min(p.step, p.totalSteps) + ' of ' + p.totalSteps;
  }

  function tookText(ms) {
    const s = Math.round((Number(ms) || 0) / 1000);
    if (s <= 0) return '';
    if (s < 60) return 'took ' + s + ' s';
    const m = Math.floor(s / 60), r = s % 60;
    return 'took ' + m + ' min' + (r ? ' ' + r + ' s' : '');
  }

  function clockText(secs) {
    const s = Math.max(0, Math.round(Number(secs) || 0));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  /** A gallery item's recipe back into form fields (Core's VideoRecipe, read defensively). */
  function formFromItem(item) {
    if (!item) return null;
    const r = (item.recipe && typeof item.recipe === 'object') ? item.recipe : {};
    const remote = (r.remote && typeof r.remote === 'object') ? r.remote : {};
    const pick = (...xs) => xs.find((x) => x !== undefined && x !== null && x !== '');
    const patch = {
      prompt: pick(r.prompt, item.prompt, ''),
      negativePrompt: pick(r.negativePrompt, ''),
      mode: (r.workflow === 'image-to-video' || r.mode === 'image-to-video') ? 'image' : 'text',
      modelId: item.model && item.model.id ? item.model.id : null,
    };
    const secs = pick(remote.durationSecs, r.durationSecs, item.durationSecs);
    if (typeof secs === 'number') patch.durationSecs = secs;
    const res = pick(remote.resolution, r.resolution);
    if (typeof res === 'string') patch.resolution = res;
    let aspect = pick(remote.aspectRatio, r.aspectRatio);
    if (!aspect && r.width && r.height) aspect = r.width >= r.height ? '16:9' : '9:16';
    if (typeof aspect === 'string') patch.aspectRatio = aspect;
    const audio = pick(remote.generateAudio, r.generateAudio, r.audio);
    if (typeof audio === 'boolean') patch.audio = audio;
    return patch;
  }

  /** Cloud models first (default first), then local; one flat lookup too. */
  function modelGroups(catalog) {
    const cloud = catalog && catalog.cloud && Array.isArray(catalog.cloud.models) ? catalog.cloud.models : [];
    const local = catalog && catalog.local && Array.isArray(catalog.local.models) ? catalog.local.models : [];
    return { cloud, local, all: cloud.concat(local) };
  }

  /** The model to select: the saved one if still listed, else the cloud default, else the first. */
  function pickModel(catalog, savedId) {
    const gr = modelGroups(catalog);
    return gr.all.find((m) => m.id === savedId) || gr.cloud.find((m) => m.default) || gr.cloud[0] || gr.local[0] || null;
  }

  /** Form fields valid for this model (keeps what still applies). */
  function fitFormToModel(form, model) {
    const f = Object.assign({}, form);
    f.modelId = model ? model.id : null;
    f.durationSecs = pickDuration(model, form.durationSecs);
    f.aspectRatio = pickAspect(model, form.aspectRatio);
    f.resolution = pickResolution(model, form.resolution);
    if (typeof f.audio !== 'boolean') f.audio = true;
    return f;
  }

  function errorText(err) {
    if (!err) return 'Something went wrong.';
    return String(err.message || err.code || 'Something went wrong.');
  }

  /**
   * Whether the window should render a poster for this gallery clip: a Studio
   * clip (not one opened from a chat) that Core has no poster for, and not
   * tried already this session (a clip that will not decode stays a play icon).
   */
  function needsPoster(item, tried) {
    if (!item || typeof item.id !== 'string' || !item.id || item.fromChat) return false;
    if (item.thumbnailPath) return false;
    if (typeof item.path !== 'string' || !item.path) return false;
    return !(tried && tried[item.id]);
  }

  /**
   * Whether the window should draw a poster for a clip opened from a chat: it
   * has no gallery id, so Core cannot keep one; the frame stays in memory for
   * this session, keyed by the item id. Tried once, like a gallery clip.
   */
  function needsChatPoster(item, tried) {
    if (!item || !item.fromChat || typeof item.id !== 'string' || !item.id) return false;
    if (typeof item.path !== 'string' || !item.path) return false;
    return !(tried && tried[item.id]);
  }

  /** The time a poster frame is taken at: 0.5 s in, or the middle of a shorter clip. */
  function posterTime(duration) {
    return Number.isFinite(duration) && duration > 0 ? Math.min(0.5, duration / 2) : 0.5;
  }

  const helpers = {
    needsPoster, needsChatPoster, posterTime,
    durationOptions, pickDuration, aspectOptions, pickAspect, resolutionOptions, pickResolution,
    supportsImageStart, localDims, buildRequest, blockReason, priceParams, priceLabel, generateLabel,
    spanText, estimateVerdict, fitChip, gbText, modelLabels, phaseList, etaText, stepText, tookText,
    clockText, formFromItem, modelGroups, pickModel, fitFormToModel, errorText, escHtml,
  };

  /* ============================================================
     page
     ============================================================ */

  function createPage() {
    const BR = () => (g.atomic && g.atomic.studio) || (g.BR && g.BR.studio) || null;
    /* Studio's preview answers {ok, data:{ok, dataUrl}} (CONTRACT.md); a bare {ok, dataUrl} is taken too. */
    const previewUrl = (r) => {
      const d = r && r.ok ? (r.data && typeof r.data === 'object' ? r.data : r) : null;
      return d && d.ok !== false && typeof d.dataUrl === 'string' ? d.dataUrl : '';
    };

    const S = {
      root: null, shown: false,
      catalog: null, catalogError: null,
      form: loadForm(),
      prices: {}, estimates: {},
      job: null, jobError: null, armed: false,
      result: null, playError: false, videoSrc: '',
      gallery: [], galleryTotal: 0, galleryFilter: 'all', galleryError: null, thumbs: {},
      delArmed: null,
      pickerOpen: false, pickerQuery: '', libraryOpen: false, library: [], libThumbs: {},
      outDir: null, busy: false, notice: null,
      focusPath: null,   // "Open in Studio" waiting for the gallery's first page
    };
    let priceTimer = null, estTimer = null;

    function loadForm() {
      const base = { prompt: '', negativePrompt: '', mode: 'text', durationSecs: DEFAULT_SECS, resolution: null, aspectRatio: '16:9', audio: true, modelId: null, firstFrame: null };
      try {
        const raw = g.localStorage && g.localStorage.getItem(STORE_KEY);
        if (raw) {
          const saved = JSON.parse(raw);
          if (saved && typeof saved === 'object') return Object.assign(base, saved, { firstFrame: saved.firstFrame && saved.firstFrame.path ? saved.firstFrame : null });
        }
      } catch (_) { /* a private window or a bad value: start fresh */ }
      return base;
    }

    function saveForm() {
      try {
        const f = Object.assign({}, S.form);
        /* A dropped picture is kept only by path; base64 is too big for storage. */
        f.firstFrame = f.firstFrame && f.firstFrame.path ? { path: f.firstFrame.path, name: f.firstFrame.name || '' } : null;
        if (g.localStorage) g.localStorage.setItem(STORE_KEY, JSON.stringify(f));
      } catch (_) { /* storage is a convenience */ }
    }

    const model = () => (S.catalog ? modelGroups(S.catalog).all.find((m) => m.id === S.form.modelId) || null : null);
    const request = () => buildRequest(S.form, model());
    const reqKey = (req) => JSON.stringify(Object.assign({}, req, { prompt: '', negativePrompt: '', firstFrame: req && req.firstFrame ? 1 : 0 }));
    const running = () => !!S.job && (S.job.state === 'queued' || S.job.state === 'generating');

    /* ---------------- data ---------------- */

    async function loadCatalog() {
      const br = BR();
      if (!br) { S.catalogError = 'Studio is not available in this window.'; paint(); return; }
      const res = await br.catalog(KIND);
      if (!res || !res.ok) { S.catalogError = errorText(res && res.error); paint(); return; }
      S.catalog = res.data; S.catalogError = null;
      S.form = fitFormToModel(S.form, pickModel(S.catalog, S.form.modelId));
      paint(); refreshQuote();
    }

    async function loadGallery() {
      const br = BR();
      if (!br) return;
      const res = await br.gallery(KIND, { offset: 0, limit: 60 });
      if (!res || !res.ok) { S.galleryError = errorText(res && res.error); paint('gallery'); return; }
      S.gallery = res.data.items || []; S.galleryTotal = res.data.total || S.gallery.length; S.galleryError = null;
      if (S.focusPath) { const p = S.focusPath; S.focusPath = null; showResult(S.gallery.find((x) => x.path === p) || fromChatItem(p)); }
      paint('gallery');
      for (const it of S.gallery) loadThumb(it);
    }

    /* Posters the window rendered or gave up on this session (CONTRACT.md "Video posters"). */
    const posterTried = {};
    let posterChain = Promise.resolve();

    /** A clip without a poster: one frame drawn here, sent to Core, then shown. One clip at a time. */
    function ensurePoster(it) {
      const br = BR();
      if (!br || typeof br.setPoster !== 'function' || !needsPoster(it, posterTried)) return;
      posterTried[it.id] = true;
      posterChain = posterChain.then(() => makePoster(it)).then(async (bytes) => {
        if (!bytes) return;
        const r = await br.setPoster(it.id, bytes);
        const item = r && r.ok && r.data ? r.data : null;
        if (!item || !item.thumbnailPath) return;
        const g0 = S.gallery.find((x) => x.id === it.id);
        if (g0) g0.thumbnailPath = item.thumbnailPath;
        if (S.result && S.result.id === it.id) S.result.thumbnailPath = item.thumbnailPath;
        delete S.thumbs[it.id];
        loadThumb(Object.assign({}, it, { thumbnailPath: item.thumbnailPath }));
      }).catch(() => undefined);   // no poster: the tile keeps its play icon
    }

    /* Posters for clips from a chat, kept in memory only (Core has no id for them). */
    const CHAT_POSTERS_MAX = 24;
    const chatPosterIds = [];

    /** A clip from a chat: one frame drawn here as a data URL and shown; nothing is sent to Core. */
    function ensureChatPoster(it) {
      if (!needsChatPoster(it, posterTried)) return;
      posterTried[it.id] = true;
      posterChain = posterChain.then(() => makePoster(it, 'dataUrl')).then((url) => {
        if (!url) return;
        chatPosterIds.push(it.id);
        while (chatPosterIds.length > CHAT_POSTERS_MAX) {
          const old = chatPosterIds.shift();
          delete S.thumbs[old]; delete posterTried[old];
        }
        S.thumbs[it.id] = url;
        if (!S.result || S.result.id !== it.id) return;
        /* Set it on the player in place: repainting the stage would stop a clip already playing. */
        const v = S.root && S.root.querySelector ? S.root.querySelector('.studio-video-player') : null;
        if (v) v.setAttribute('poster', url); else paint('stage');
      }).catch(() => undefined);   // no poster: the player looks as before
    }

    /** A frame ~0.5 s into the clip: PNG bytes (Core takes only a PNG), or a PNG data URL with as = 'dataUrl'; null on failure. */
    function makePoster(it, as) {
      const doc = g.document;
      const src = g.STUDIO && typeof g.STUDIO.mediaUrl === 'function' ? g.STUDIO.mediaUrl(it.path) : '';
      if (!doc || !src) return Promise.resolve(null);
      return new Promise((resolve) => {
        const v = doc.createElement('video');
        let done = false;
        const finish = (val) => {
          if (done) return;
          done = true;
          g.clearTimeout(timer);
          try { v.removeAttribute('src'); v.load(); } catch (_) { /* gone already */ }
          resolve(val);
        };
        const timer = g.setTimeout(() => finish(null), 15000);
        v.muted = true; v.preload = 'auto'; v.playsInline = true;
        v.addEventListener('error', () => finish(null));
        v.addEventListener('loadedmetadata', () => { try { v.currentTime = posterTime(v.duration); } catch (_) { finish(null); } });
        v.addEventListener('seeked', () => {
          try {
            const w = v.videoWidth, h = v.videoHeight;
            if (!w || !h) return finish(null);
            const scale = Math.min(1, 640 / w);
            const c = doc.createElement('canvas');
            c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(h * scale));
            c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
            if (as === 'dataUrl') {
              const url = c.toDataURL('image/png');
              return finish(typeof url === 'string' && url.startsWith('data:image/png') ? url : null);
            }
            c.toBlob((blob) => {
              if (!blob) return finish(null);
              blob.arrayBuffer().then((buf) => finish(new Uint8Array(buf)), () => finish(null));
            }, 'image/png');
          } catch (_) { finish(null); }   // a tainted canvas or a decoder error
        });
        v.src = src;
      });
    }

    async function loadThumb(it) {
      const br = BR();
      if (it.fromChat) { ensureChatPoster(it); return; }
      if (br && !it.thumbnailPath) { ensurePoster(it); return; }
      if (!br || !it.thumbnailPath || S.thumbs[it.id] !== undefined) return;
      S.thumbs[it.id] = null;
      const url = previewUrl(await br.preview(it.thumbnailPath));
      if (url) { S.thumbs[it.id] = url; paint('gallery'); if (S.result && S.result.id === it.id) paint('stage'); }
    }

    async function loadOutDir() {
      const br = BR();
      if (!br || !br.outputDir) return;
      const r = await br.outputDir(KIND);
      if (r && r.ok) { S.outDir = r.data; paint('top'); }
    }

    async function recoverJob() {
      const br = BR();
      if (!br || !br.activeJobs || running()) return;
      const r = await br.activeJobs();
      const j = r && r.ok && Array.isArray(r.data) ? r.data.find((x) => x.kind === KIND) : null;
      if (j) onJob(j);
    }

    /** Price (cloud) and estimate (local), debounced; both are cached by request shape. */
    function refreshQuote() {
      const m = model(), req = request();
      if (!m || !req) return;
      const key = m.id + '|' + reqKey(req);
      if (!isLocal(m)) {
        if (key in S.prices) { paint('foot'); return; }
        clearTimeout(priceTimer);
        priceTimer = setTimeout(async () => {
          const br = BR();
          if (!br || !br.price) return;
          const r = await br.price(m.id, priceParams(req));
          S.prices[key] = r && r.ok ? r.data : null;
          paint('foot'); if (S.pickerOpen) paint('picker-list');
        }, 250);
      } else {
        if (key in S.estimates) { paint('foot'); return; }
        clearTimeout(estTimer);
        estTimer = setTimeout(() => estimateFor(m, req, key).then(() => paint('foot')), 300);
      }
    }

    async function estimateFor(m, req, key) {
      const br = BR();
      if (!br || !br.estimateVideo) return;
      S.estimates[key] = undefined;
      const r = await br.estimateVideo(Object.assign({}, req, { prompt: req.prompt || 'estimate' }));
      S.estimates[key] = r && r.ok ? r.data : null;
    }

    function currentPrice() {
      const m = model(), req = request();
      return m && req && !isLocal(m) ? S.prices[m.id + '|' + reqKey(req)] || null : null;
    }

    function currentEstimate() {
      const m = model(), req = request();
      return m && req && isLocal(m) ? S.estimates[m.id + '|' + reqKey(req)] || null : null;
    }

    /** Prices for every cloud model in the picker (main caches them for 24 h). */
    function priceClouds() {
      const br = BR();
      if (!S.catalog || !br || !br.price) return;
      for (const m of modelGroups(S.catalog).cloud) {
        const req = buildRequest(fitFormToModel(S.form, m), m);
        const key = m.id + '|' + reqKey(req);
        if (key in S.prices) continue;
        S.prices[key] = null;
        br.price(m.id, priceParams(req)).then((r) => { S.prices[key] = r && r.ok ? r.data : null; if (S.pickerOpen) paint('picker-list'); });
      }
    }

    /** Fit chips for every local model in the picker. */
    function estimateLocals() {
      if (!S.catalog) return;
      for (const m of modelGroups(S.catalog).local) {
        const req = buildRequest(Object.assign({}, S.form, { mode: 'text' }), m);
        const key = m.id + '|' + reqKey(req);
        if (!(key in S.estimates)) estimateFor(m, req, key).then(() => { if (S.pickerOpen) paint('picker-list'); });
      }
    }

    /* ---------------- actions ---------------- */

    async function generate() {
      const m = model(), req = request();
      if (S.busy || running()) return;
      const why = blockReason(S.form, m);
      if (why) { S.notice = why; paint('foot'); return; }
      const v = isLocal(m) ? estimateVerdict(currentEstimate()) : null;
      if (v && v.level === 'exceeds' && !S.armed) { S.armed = true; paint('foot'); return; }
      const br = BR();
      if (!br) return;
      S.busy = true; S.armed = false; S.notice = null; S.jobError = null; paint('foot');
      saveForm();
      const r = await br.generateVideo(req);
      S.busy = false;
      if (!r || !r.ok) { S.jobError = r ? r.error : { code: 'FAILED', message: 'Could not start the clip.' }; paint(); return; }
      S.job = Object.assign({}, r.data.job, { id: r.data.jobId || r.data.job.id, startedAt: Date.now(), label: summaryLine(m) });
      S.result = null;
      paint();
    }

    async function stop() {
      const br = BR();
      if (!br || !S.job) return;
      const r = await br.cancel(KIND, S.job.id);
      if (r && r.ok && !r.data.cancelled && !r.data.serverStopped) { S.notice = 'Could not stop it. It may already be finishing.'; paint('stage'); }
    }

    function onJob(job) {
      if (!job || job.kind !== KIND) return;
      if (S.job && S.job.id !== job.id && running()) return;
      const prev = S.job && S.job.id === job.id ? S.job : null;
      S.job = Object.assign({}, prev || { startedAt: job.createdAtMs || Date.now(), label: job.model }, job);
      if (job.state === 'completed') {
        const item = (job.outputs || [])[0] || null;
        if (item) showResult(item);
        S.job = null;
        loadGallery();
      } else if (job.state === 'failed') {
        S.jobError = job.error || { code: 'FAILED', message: 'The clip failed.' }; S.job = null;
      } else if (job.state === 'cancelled') {
        S.notice = 'Stopped.'; S.job = null;
      }
      paint('stage'); paint('foot');
    }

    async function showResult(item) {
      S.result = item; S.playError = false; S.videoSrc = '';
      const br = BR();
      if (br && typeof br.mediaUrl === 'function') {
        try { const u = await br.mediaUrl(item.path); S.videoSrc = typeof u === 'string' ? u : (u && u.ok && u.data && u.data.url) || (u && u.url) || ''; } catch (_) { S.videoSrc = ''; }
      }
      /* The window's CSP allows media-src file:; the shell encodes the path (spaces, #, ?). */
      if (!S.videoSrc && g.STUDIO && typeof g.STUDIO.mediaUrl === 'function') S.videoSrc = g.STUDIO.mediaUrl(item.path) || '';
      if (!S.videoSrc) S.playError = true;
      loadThumb(item);
      paint('stage'); paint('gallery');
    }

    /** A clip Studio did not make (video.generate saves into the working folder), shown on its own. */
    function fromChatItem(path) {
      return { id: 'chat:' + path, path, fromChat: true, prompt: '', model: null, durationSecs: null, height: null, thumbnailPath: null, pinned: false };
    }

    /** "Open in Studio" from a chat: the gallery's clip when Studio made it, else the file itself. */
    function focusFile(path) {
      if (!path) return;
      S.jobError = null; S.notice = null;
      const hit = S.gallery.find((x) => x.path === path);
      if (hit) { showResult(hit); return; }
      const st = g.STUDIO;
      if (st && typeof st.isStudioFile === 'function' && st.isStudioFile(path, KIND)) { S.focusPath = path; loadGallery(); return; }
      showResult(fromChatItem(path));
    }

    /** Save as… / Show in Finder: Studio's routes for its clips, the reply-file routes (home folder) for one from a chat. */
    function fileAction(what) {
      const it = S.result;
      if (!it) return;
      const say = (r, verb) => {
        if (r && r.ok && (verb !== 'save' || (r.data ? r.data.saved !== false : true))) return;
        if (r && (r.reason === 'canceled' || (r.data && r.data.saved === false))) return;
        S.notice = (r && r.error && r.error.message) || (verb === 'save' ? 'Could not save it. The clip may have been moved.' : 'Could not show it. The clip may have been moved.');
        paint('stage');
      };
      if (it.fromChat) {
        const a = g.atomic || {};
        const fn = what === 'save' ? a.replySaveAs : a.replyReveal;
        if (typeof fn === 'function') Promise.resolve(fn(it.path)).then((r) => say(r, what), () => say(null, what));
        return;
      }
      const br = BR();
      if (!br) return;
      Promise.resolve(what === 'save' ? br.saveAs(it.path) : br.revealInFinder(it.path)).then((r) => say(r, what), () => say(null, what));
    }

    function restore(item) {
      const patch = formFromItem(item);
      if (!patch) return;
      const all = S.catalog ? modelGroups(S.catalog).all : [];
      const m = all.find((x) => x.id === patch.modelId) || model();
      const ff = S.form.firstFrame;
      S.form = fitFormToModel(Object.assign({}, S.form, patch, { firstFrame: patch.mode === 'image' ? ff : S.form.firstFrame }), m);
      if (m && !all.find((x) => x.id === patch.modelId)) S.notice = 'That model is not listed any more, so the current one stays.';
      saveForm(); paint(); refreshQuote();
    }

    function sendToChat(item) {
      const detail = { kind: KIND, path: item.path, prompt: item.prompt || '', name: (item.path || '').split('/').pop() };
      if (g.STUDIO && typeof g.STUDIO.sendToChat === 'function') { g.STUDIO.sendToChat(detail); return; }
      try { g.dispatchEvent(new g.CustomEvent('studio:send-to-chat', { detail })); } catch (_) { /* no window */ }
    }

    function copyPath(path) {
      if (typeof g.copyText === 'function') { g.copyText(path, 'Path copied'); return; }
      if (g.navigator && g.navigator.clipboard) g.navigator.clipboard.writeText(path).catch(() => {});
    }

    async function setFirstFrameFromPath(path, name, from) {
      const br = BR();
      S.form.firstFrame = { path, name: name || path.split('/').pop(), from: from || '', dataUrl: '' };
      paint('form');
      if (br) {
        const url = previewUrl(await br.preview(path));
        if (url && S.form.firstFrame && S.form.firstFrame.path === path) { S.form.firstFrame.dataUrl = url; paint('form'); }
      }
      saveForm(); refreshQuote(); paint('foot');
    }

    function setFirstFrameFromFile(file) {
      if (!file || !/^image\//.test(file.type || '')) { S.notice = 'Drop a PNG or JPG.'; paint('foot'); return; }
      const fr = new g.FileReader();
      fr.onload = () => {
        S.form.firstFrame = { base64: String(fr.result), dataUrl: String(fr.result), name: file.name, from: 'dropped' };
        paint('form'); paint('foot'); refreshQuote();
      };
      fr.readAsDataURL(file);
    }

    async function openLibrary() {
      S.libraryOpen = !S.libraryOpen; paint('form');
      if (!S.libraryOpen) return;
      const br = BR();
      if (!br) return;
      const r = await br.gallery('image', { limit: 40 });
      S.library = r && r.ok ? r.data.items || [] : [];
      paint('form');
      for (const it of S.library) {
        const p = it.thumbnailPath || it.path;
        if (S.libThumbs[it.id] !== undefined) continue;
        S.libThumbs[it.id] = null;
        br.preview(p).then((x) => { const url = previewUrl(x); if (url) { S.libThumbs[it.id] = url; if (S.libraryOpen) paint('form'); } });
      }
    }

    async function pin(id, on) {
      const br = BR();
      if (!br) return;
      const r = await br.pin(KIND, id, on);
      if (r && r.ok && r.data) {
        S.gallery = S.gallery.map((x) => (x.id === id ? r.data : x));
        if (S.result && S.result.id === id) S.result = r.data;
        paint('gallery');
      }
    }

    async function del(id) {
      if (S.delArmed !== id) { S.delArmed = id; paint('gallery'); return; }
      const br = BR();
      S.delArmed = null;
      if (!br) return;
      const r = await br.galleryDelete(KIND, [id]);
      if (r && r.ok) {
        S.gallery = S.gallery.filter((x) => x.id !== id);
        S.galleryTotal = Math.max(0, S.galleryTotal - 1);
        if (S.result && S.result.id === id) S.result = null;
      } else S.galleryError = errorText(r && r.error);
      paint('gallery'); paint('stage');
    }

    async function chooseDir() {
      const br = BR();
      if (!br || !br.chooseOutputDir) return;
      const r = await br.chooseOutputDir(KIND);
      if (r && r.ok && r.data) { S.outDir = r.data; paint('top'); loadGallery(); }
    }

    function selectModel(id) {
      const m = modelGroups(S.catalog).all.find((x) => x.id === id);
      if (!m) return;
      if (S.form.mode === 'image' && isLocal(m)) return;
      S.form = fitFormToModel(S.form, m);
      S.pickerOpen = false; S.armed = false; S.notice = null;
      saveForm(); paint(); refreshQuote();
    }

    function summaryLine(m) {
      const bits = [m ? m.name : ''];
      const f = S.form;
      if (f.resolution && m && !isLocal(m)) bits.push(f.resolution);
      if (f.aspectRatio) bits.push(f.aspectRatio);
      if (m && m.audio && f.audio && !isLocal(m)) bits.push('with sound');
      return bits.filter(Boolean).join(' · ');
    }

    function dispatch(a, el, ev) {
      const v = el.getAttribute('data-v');
      const f = S.form;
      switch (a) {
        case 'mode': f.mode = v; S.armed = false; S.notice = null; saveForm(); paint(); refreshQuote(); break;
        case 'dur': f.durationSecs = Number(v); saveForm(); paint('form'); refreshQuote(); break;
        case 'aspect': f.aspectRatio = v; S.armed = false; saveForm(); paint('form'); refreshQuote(); break;
        case 'audio': f.audio = !f.audio; saveForm(); paint('form'); refreshQuote(); break;
        case 'picker': S.pickerOpen = !S.pickerOpen; S.pickerQuery = ''; paint('picker'); paint('form'); if (S.pickerOpen) { estimateLocals(); priceClouds(); } break;
        case 'model': selectModel(v); break;
        case 'pick-file': S.libraryOpen = false; BR() && BR().pickImages(false).then((r) => { const p = r && r.ok && r.data && r.data[0]; if (p) setFirstFrameFromPath(p.path, p.name, 'picked'); }); break;
        case 'pick-library': openLibrary(); break;
        case 'lib-item': { const it = S.library.find((x) => x.id === v); S.libraryOpen = false; if (it) setFirstFrameFromPath(it.path, it.path.split('/').pop(), 'from your images'); break; }
        case 'clear-frame': f.firstFrame = null; saveForm(); paint('form'); paint('foot'); break;
        case 'generate': generate(); break;
        case 'stop': stop(); break;
        case 'dismiss': S.jobError = null; S.notice = null; paint('stage'); paint('foot'); break;
        case 'save-as': fileAction('save'); break;
        case 'reveal': fileAction('reveal'); break;
        case 'copy-path': S.result && copyPath(S.result.path); break;
        case 'restore': S.result && restore(S.result); break;
        case 'send': S.result && sendToChat(S.result); break;
        case 'filter': S.galleryFilter = v; paint('gallery'); break;
        case 'open-item': { const it = S.gallery.find((x) => x.id === v); if (it) showResult(it); break; }
        case 'pin': { const it = S.gallery.find((x) => x.id === v); if (it) pin(v, !it.pinned); break; }
        case 'del': del(v); break;
        case 'out-dir': chooseDir(); break;
        case 'retry-catalog': loadCatalog(); break;
        case 'settings': if (g.STUDIO && typeof g.STUDIO.openSettings === 'function') g.STUDIO.openSettings('openrouter'); else try { g.dispatchEvent(new g.CustomEvent('studio:open-settings', { detail: { pane: 'openrouter' } })); } catch (_) { /* no window */ } break;
        default: return;
      }
      if (ev) ev.preventDefault();
    }

    /* ---------------- events ---------------- */

    function bind(root) {
      root.addEventListener('click', (ev) => {
        const el = ev.target.closest('[data-vact]');
        const a = el && root.contains(el) ? el.getAttribute('data-vact') : null;
        if (S.pickerOpen && !ev.target.closest('.studio-video-picker') && a !== 'picker') { S.pickerOpen = false; paint('picker'); paint('form'); }
        if (!a || el.disabled) return;
        if (S.delArmed && el.getAttribute('data-vact') !== 'del') { S.delArmed = null; paint('gallery'); }
        dispatch(a, el, ev);
      });
      root.addEventListener('input', (ev) => {
        const t = ev.target;
        if (t.matches('[data-vfield="prompt"]')) { S.form.prompt = t.value; S.notice = null; saveForm(); paint('foot'); }
        else if (t.matches('[data-vfield="negative"]')) { S.form.negativePrompt = t.value; saveForm(); }
        else if (t.matches('[data-vfield="pickerq"]')) { S.pickerQuery = t.value; paint('picker-list'); }
      });
      root.addEventListener('change', (ev) => {
        const t = ev.target;
        if (t.matches('[data-vfield="resolution"]')) { S.form.resolution = t.value; saveForm(); refreshQuote(); }
      });
      root.addEventListener('keydown', (ev) => {
        if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') { ev.preventDefault(); generate(); }
        else if (ev.key === 'Escape' && (S.pickerOpen || S.libraryOpen)) { S.pickerOpen = false; S.libraryOpen = false; paint('picker'); paint('form'); }
      });
      root.addEventListener('dragover', (ev) => {
        if (ev.target.closest('.studio-video-drop')) { ev.preventDefault(); ev.target.closest('.studio-video-drop').classList.add('over'); }
      });
      root.addEventListener('dragleave', (ev) => {
        const d = ev.target.closest('.studio-video-drop'); if (d) d.classList.remove('over');
      });
      root.addEventListener('drop', (ev) => {
        const d = ev.target.closest('.studio-video-drop');
        if (!d) return;
        ev.preventDefault(); d.classList.remove('over');
        const file = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
        if (file) setFirstFrameFromFile(file);
      });
      /* <video> errors do not bubble; catch them on the way down. */
      root.addEventListener('error', (ev) => {
        if (ev.target && ev.target.tagName === 'VIDEO') { S.playError = true; paint('stage'); }
      }, true);
    }

    /* ---------------- view ---------------- */

    function viewTop() {
      const d = S.outDir && S.outDir.path ? S.outDir.path.replace(/^\/Users\/[^/]+/, '~') : '';
      return '<div class="studio-top"><h2>Video</h2><span class="studio-sub">Short clips from text or a first frame</span><span class="studio-sp"></span>'
        + (d ? '<button class="studio-pill" data-vact="out-dir" title="Where clips are saved">' + icon('folder') + '<span>' + escHtml(d) + '</span></button>' : '')
        + '</div>';
    }

    function viewForm() {
      const f = S.form, m = model();
      if (S.catalogError) {
        return '<div class="studio-video-err">' + icon('warn') + '<span>' + escHtml(S.catalogError) + '</span><button class="studio-btn" data-vact="retry-catalog">Retry</button></div>';
      }
      if (!S.catalog) return '<div class="studio-video-loading">Loading models…</div>';
      let h = '';
      h += '<label class="studio-lbl" for="sv-prompt">Prompt</label>'
        + '<textarea id="sv-prompt" class="studio-ta" data-vfield="prompt" rows="4" placeholder="' + (f.mode === 'image' ? 'What happens next (optional)' : 'A fox closes a book and smiles at the camera. Slow push-in.') + '">' + escHtml(f.prompt) + '</textarea>';
      if (m && m.negativePrompt) {
        h += '<label class="studio-lbl" for="sv-neg">Leave out</label>'
          + '<input id="sv-neg" class="studio-input" data-vfield="negative" placeholder="blur, text, watermark" value="' + escHtml(f.negativePrompt) + '">';
      }
      h += '<div class="studio-lbl">Start from</div><div class="studio-seg" role="tablist">'
        + segBtn('mode', 'text', 'Text', f.mode !== 'image')
        + segBtn('mode', 'image', 'Image <span class="studio-dim">first frame</span>', f.mode === 'image')
        + '</div>';
      if (f.mode === 'image') h += viewFrame(m);
      const durs = durationOptions(m);
      if (durs.length) {
        h += '<div class="studio-lbl">Length</div><div class="studio-chips">'
          + durs.map((d) => '<button class="studio-chip' + (d === f.durationSecs ? ' on' : '') + '" data-vact="dur" data-v="' + d + '">' + d + ' s</button>').join('')
          + '</div>';
      }
      const res = resolutionOptions(m), asp = aspectOptions(m);
      if (res.length || asp.length) {
        h += '<div class="studio-row2">';
        if (res.length) {
          h += '<div><label class="studio-lbl" for="sv-res">Resolution</label><select id="sv-res" class="studio-select" data-vfield="resolution">'
            + res.map((r) => '<option value="' + escHtml(r) + '"' + (r === f.resolution ? ' selected' : '') + '>' + escHtml(r) + '</option>').join('')
            + '</select></div>';
        }
        if (asp.length) {
          h += '<div><div class="studio-lbl">Shape</div><div class="studio-seg">'
            + asp.map((a) => segBtn('aspect', a, escHtml(a), a === f.aspectRatio)).join('') + '</div></div>';
        }
        h += '</div>';
      }
      if (m && m.audio && !isLocal(m)) {
        h += '<button class="studio-line" data-vact="audio" role="switch" aria-checked="' + (f.audio ? 'true' : 'false') + '">'
          + '<span class="studio-sp">Sound<small>Music and effects made with the clip</small></span>'
          + '<span class="studio-switch' + (f.audio ? ' on' : '') + '"></span></button>';
      }
      h += '<div class="studio-lbl">Model</div>' + viewModelButton(m);
      return h;
    }

    function segBtn(act, v, label, on) {
      return '<button class="' + (on ? 'on' : '') + '" role="tab" aria-selected="' + on + '" data-vact="' + act + '" data-v="' + escHtml(v) + '">' + label + '</button>';
    }

    function viewFrame(m) {
      const ff = S.form.firstFrame;
      let h = '<div class="studio-lbl">First frame</div>';
      if (m && isLocal(m)) {
        h += '<div class="studio-video-soon">' + icon('info') + '<span>Starting from an image on this Mac is coming soon. Cloud models can do it now.</span></div>';
      }
      if (ff) {
        h += '<div class="studio-video-drop filled">'
          + (ff.dataUrl ? '<img class="studio-video-src" alt="" src="' + escHtml(ff.dataUrl) + '">' : '<div class="studio-video-src"></div>')
          + '<div class="studio-sp"><div class="studio-video-dt">' + escHtml(ff.name || 'Image') + '</div><div class="studio-video-ds">' + escHtml(ff.from || '') + '</div></div>'
          + '<button class="studio-iconbtn" data-vact="clear-frame" aria-label="Remove the first frame">' + icon('x') + '</button></div>';
      } else {
        h += '<div class="studio-video-drop" tabindex="0">'
          + '<div class="studio-video-di">' + icon('image') + '</div>'
          + '<div><div class="studio-video-dt">Drop an image, <button class="studio-link" data-vact="pick-file">choose a file</button> or <button class="studio-link" data-vact="pick-library">pick from your images</button></div>'
          + '<div class="studio-video-ds">PNG or JPG. It becomes the opening shot.</div></div></div>';
      }
      if (S.libraryOpen) {
        h += '<div class="studio-video-library">'
          + (S.library.length
            ? S.library.map((it) => '<button class="studio-video-libitem" data-vact="lib-item" data-v="' + escHtml(it.id) + '" title="' + escHtml(it.prompt || '') + '">'
              + (S.libThumbs[it.id] ? '<img alt="" src="' + escHtml(S.libThumbs[it.id]) + '">' : '') + '</button>').join('')
            : '<div class="studio-video-ds">No images yet. Make one on the Images page.</div>')
          + '</div>';
      }
      return h;
    }

    function viewModelButton(m) {
      if (!m) return '<button class="studio-model" data-vact="picker">Pick a model</button>';
      const local = isLocal(m);
      const meta = local ? 'On this Mac' + (m.local && m.local.developer ? ' · ' + m.local.developer : '') : 'via OpenRouter';
      return '<button class="studio-model' + (S.pickerOpen ? ' open' : '') + '" data-vact="picker" aria-haspopup="listbox" aria-expanded="' + S.pickerOpen + '">'
        + '<span class="studio-sp"><span class="studio-mname">' + escHtml(m.name) + '</span><span class="studio-mmeta">' + escHtml(meta) + '</span></span>'
        + '<span class="studio-tag ' + (local ? 'local' : 'cloud') + '">' + icon(local ? 'cpu' : 'cloud') + (local ? 'This Mac' : 'Cloud') + '</span>'
        + icon('chevD') + '</button>';
    }

    function viewPicker() {
      if (!S.pickerOpen || !S.catalog) return '';
      return '<div class="studio-pop studio-video-picker" role="listbox">'
        + '<input class="studio-input" data-vfield="pickerq" placeholder="Search video models" value="' + escHtml(S.pickerQuery) + '">'
        + '<div class="studio-video-plist">' + viewPickerList() + '</div></div>';
    }

    function viewPickerList() {
      const gr = modelGroups(S.catalog), q = S.pickerQuery.trim().toLowerCase();
      const match = (m) => !q || (m.name + ' ' + m.id).toLowerCase().includes(q);
      const f = S.form;
      let h = '';
      const cloud = gr.cloud.filter(match), local = gr.local.filter(match);
      if (cloud.length) {
        h += '<div class="studio-pop-g">' + icon('cloud') + 'Cloud · OpenRouter'
          + (S.catalog.cloud.keyMissing ? '<span class="r">needs an OpenRouter key</span>' : '') + '</div>';
        for (const m of cloud) {
          const req = buildRequest(fitFormToModel(f, m), m);
          const price = S.prices[m.id + '|' + reqKey(req)];
          const disabled = f.mode === 'image' && !supportsImageStart(m);
          h += optRow(m, priceLabel(price), disabled, '');
        }
      }
      if (local.length) {
        h += '<div class="studio-pop-g">' + icon('cpu') + 'On this Mac · free, private</div>';
        for (const m of local) {
          const req = buildRequest(Object.assign({}, fitFormToModel(f, m), { mode: 'text' }), m);
          const est = S.estimates[m.id + '|' + reqKey(req)];
          const chip = fitChip(est);
          const size = gbText(m.sizeBytes || (m.local && m.local.sizeBytes));
          const v = estimateVerdict(est);
          const right = est && est.seconds ? spanText(est.seconds.low, est.seconds.high) : '';
          const extra = (size ? '<span>' + size + '</span>' : '') + (chip ? '<span class="studio-tag ' + chip.cls + '">' + chip.text + '</span>' : '');
          h += optRow(m, right, f.mode === 'image', extra, v.level === 'exceeds');
        }
      }
      if (S.catalog.cloud && S.catalog.cloud.error) h += '<div class="studio-video-ds studio-video-perr">' + escHtml(S.catalog.cloud.error.message) + '</div>';
      return h || '<div class="studio-video-ds studio-video-perr">No models match.</div>';
    }

    function optRow(m, right, disabled, extra, dim) {
      const on = m.id === S.form.modelId;
      const labels = modelLabels(m, S.form.mode).map((l) => '<span class="studio-tag ' + l.cls + '">' + escHtml(l.text) + '</span>').join('');
      return '<button class="studio-opt' + (on ? ' on' : '') + (disabled || dim ? ' dim' : '') + '" role="option" aria-selected="' + on + '"'
        + (disabled ? ' disabled' : '') + ' data-vact="model" data-v="' + escHtml(m.id) + '">'
        + '<span class="studio-sp"><span class="studio-mname">' + escHtml(m.name) + '</span>'
        + '<span class="studio-mmeta">' + extra + labels + '</span></span>'
        + (right ? '<span class="studio-price">' + escHtml(right) + '</span>' : '') + '</button>';
    }

    function viewFoot() {
      const m = model();
      if (!m) return '';
      const local = isLocal(m);
      const why = blockReason(S.form, m);
      let h = '';
      if (local) {
        const est = currentEstimate();
        const v = estimateVerdict(est);
        h += '<div class="studio-est ' + v.level + '">' + icon(v.level === 'exceeds' ? 'warn' : 'cpu') + '<span><b>Free</b>' + (v.text ? ' · ' + escHtml(v.text) : '') + '</span></div>';
        if (v.warn) h += '<div class="studio-est warn">' + icon('warn') + '<span>' + escHtml(v.warn) + (S.armed ? '. Click again to start anyway.' : '. Close other apps or pick a smaller model.') + '</span></div>';
        if (m.local && !m.local.loaded) h += '<div class="studio-est">' + icon('info') + '<span>Load this model in Atomic Core first.</span></div>';
      } else if (S.catalog && S.catalog.cloud && S.catalog.cloud.keyMissing) {
        h += '<div class="studio-est warn">' + icon('key') + '<span>Cloud clips need an OpenRouter key.</span><button class="studio-link" data-vact="settings">Add a key</button></div>';
      }
      if (S.notice) h += '<div class="studio-est">' + icon('info') + '<span>' + escHtml(S.notice) + '</span></div>';
      const label = generateLabel({ price: currentPrice(), local, armed: S.armed });
      const disabled = S.busy || running() || !!why;
      h += '<button class="studio-go' + (S.armed ? ' armed' : '') + '" data-vact="generate"' + (disabled ? ' disabled' : '') + (why ? ' title="' + escHtml(why) + '"' : '') + '>'
        + (running() ? 'Working…' : S.busy ? 'Starting…' : escHtml(label)) + (disabled ? '' : ' <kbd>⌘ ↵</kbd>') + '</button>';
      return h;
    }

    function viewStage() {
      if (running()) return viewProgress();
      if (S.jobError) return viewError();
      if (S.result) return viewResult();
      return '<div class="studio-viewer studio-empty"><div class="studio-empty-big">' + icon('play') + '</div>'
        + '<h3>Your clips play here</h3><p>Start from text, or give a first frame to bring a picture to life.</p></div>';
    }

    function viewProgress() {
      const j = S.job, p = j.progress || {};
      const pct = Math.round(Math.max(0, Math.min(1, p.fraction || 0)) * 100);
      const phases = phaseList(j);
      const now = phases.find((x) => x.status === 'now');
      const step = stepText(j);
      let h = '<div class="studio-viewer"><div class="studio-prog" role="status" aria-live="polite">'
        + '<div class="studio-prog-h"><span class="studio-spin"></span><div><div class="t">Making your clip</div><div class="s">' + escHtml(j.label || j.model || '') + '</div></div></div>'
        + '<div class="studio-bar"><i style="width:' + pct + '%"></i></div>'
        + '<div class="studio-prog-m"><span>' + escHtml(now ? now.text : 'Starting') + (step ? ' · ' + step : '') + '</span><span class="mono">' + escHtml(etaText(p.etaSeconds)) + '</span></div>'
        + '<div class="studio-phases">' + phases.map((x) => '<div class="studio-ph ' + x.status + '"><span class="c">' + (x.status === 'done' ? icon('check') : '') + '</span>' + escHtml(x.text) + '</div>').join('') + '</div>';
      if (p.slowdown) h += '<div class="studio-notebox warn">' + icon('warn') + '<span>Slowed down a lot, memory is full. Stop and try a shorter clip or a smaller model.</span></div>';
      if (j.cloud) h += '<div class="studio-notebox">' + icon('info') + "<span>Stop doesn't cancel the charge.</span></div>";
      if (S.notice) h += '<div class="studio-notebox">' + icon('info') + '<span>' + escHtml(S.notice) + '</span></div>';
      h += '<div class="studio-prog-f"><span class="studio-sp"></span><button class="studio-btn" data-vact="stop">' + icon('stop') + 'Stop</button></div></div></div>';
      return h;
    }

    function viewError() {
      const e = S.jobError;
      const key = e.code === 'NO_KEY' ? '<button class="studio-btn" data-vact="settings">' + icon('key') + 'Add a key</button>' : '';
      return '<div class="studio-viewer studio-empty"><div class="studio-video-err">' + icon('warn') + '<span>' + escHtml(errorText(e)) + '</span></div>'
        + '<div class="studio-below">' + key + '<button class="studio-btn" data-vact="dismiss">OK</button></div></div>';
    }

    function viewResult() {
      const it = S.result;
      if (it.fromChat) return viewFromChat(it);
      const poster = S.thumbs[it.id] ? ' poster="' + escHtml(S.thumbs[it.id]) + '"' : '';
      const meta = [it.model && it.model.name, it.durationSecs ? Math.round(it.durationSecs) + ' s' : '', it.height ? it.height + 'p' : '', 'MP4'].filter(Boolean).join(' · ');
      let h = '<div class="studio-viewer studio-video-result">';
      h += S.playError
        ? '<div class="studio-video-noplay">' + (S.thumbs[it.id] ? '<img alt="" src="' + escHtml(S.thumbs[it.id]) + '">' : '') + '<span>' + NO_PLAY + '</span></div>'
        : '<video class="studio-video-player" controls preload="metadata"' + poster + ' src="' + escHtml(S.videoSrc) + '"></video>';
      h += '<div class="studio-below"><span class="studio-meta">' + escHtml(meta) + '</span>'
        + '<button class="studio-btn" data-vact="save-as">' + icon('download') + 'Save as…</button>'
        + '<button class="studio-btn" data-vact="reveal">' + icon('folder') + 'Show in Finder</button>'
        + '<button class="studio-btn" data-vact="copy-path">' + icon('copy') + 'Copy path</button>'
        + '<button class="studio-btn" data-vact="restore">' + icon('undo') + 'Restore these settings</button>'
        + '<button class="studio-btn pri" data-vact="send">' + icon('send') + 'Send to chat</button></div></div>';
      return h;
    }

    /* A clip that will not play: gone since, or a codec Chromium does not have. */
    const NO_PLAY = 'This clip can\'t play here. It may have been moved, or its format isn\'t supported. Show in Finder opens it in another player.';

    function viewFromChat(it) {
      const name = String(it.path).split(/[\\/]/).pop() || it.path;
      const th = S.thumbs[it.id];
      let h = '<div class="studio-viewer studio-video-result">';
      h += S.playError
        ? '<div class="studio-video-noplay">' + (th ? '<img alt="" src="' + escHtml(th) + '">' : '') + '<span>' + NO_PLAY + '</span></div>'
        : '<video class="studio-video-player" controls preload="metadata"' + (th ? ' poster="' + escHtml(th) + '"' : '') + ' src="' + escHtml(S.videoSrc) + '"></video>';
      if (S.notice) h += '<div class="studio-notebox">' + icon('info') + '<span>' + escHtml(S.notice) + '</span></div>';
      h += '<div class="studio-below"><span class="studio-meta" title="' + escHtml(it.path) + '">From chat · ' + escHtml(name) + '</span>'
        + '<button class="studio-btn" data-vact="save-as">' + icon('download') + 'Save as…</button>'
        + '<button class="studio-btn" data-vact="reveal">' + icon('folder') + 'Show in Finder</button>'
        + '<button class="studio-btn" data-vact="copy-path">' + icon('copy') + 'Copy path</button>'
        + '<button class="studio-btn pri" data-vact="send">' + icon('send') + 'Send to chat</button></div></div>';
      return h;
    }

    function viewGallery() {
      const pinned = S.gallery.filter((x) => x.pinned);
      const items = S.galleryFilter === 'pinned' ? pinned : S.gallery;
      let h = '<div class="studio-gal-h"><h4>Clips</h4><span class="ct">' + S.galleryTotal + (S.galleryTotal === 1 ? ' clip' : ' clips') + '</span><span class="studio-sp"></span>'
        + '<div class="studio-seg">' + segBtn('filter', 'all', 'All', S.galleryFilter !== 'pinned') + segBtn('filter', 'pinned', 'Pinned' + (pinned.length ? ' · ' + pinned.length : ''), S.galleryFilter === 'pinned') + '</div></div>';
      if (S.galleryError) h += '<div class="studio-video-ds studio-video-perr">' + escHtml(S.galleryError) + '</div>';
      h += '<div class="studio-thumbs">';
      if (running()) h += '<div class="studio-th ghost"></div>';
      for (const it of items) {
        const th = S.thumbs[it.id];
        const on = S.result && S.result.id === it.id;
        h += '<div class="studio-th' + (on ? ' on' : '') + '">'
          + '<button class="studio-th-open" data-vact="open-item" data-v="' + escHtml(it.id) + '" aria-label="Play ' + escHtml(it.prompt || 'clip') + '">'
          + (th ? '<img alt="" src="' + escHtml(th) + '">' : '') + '<span class="studio-th-play">' + icon('play') + '</span>'
          + (it.durationSecs ? '<span class="studio-th-dur">' + clockText(it.durationSecs) + '</span>' : '') + '</button>'
          + '<span class="studio-th-acts">'
          + '<button class="studio-iconbtn' + (it.pinned ? ' on' : '') + '" data-vact="pin" data-v="' + escHtml(it.id) + '" aria-label="' + (it.pinned ? 'Unpin' : 'Pin') + '">' + icon('pin') + '</button>'
          + (S.delArmed === it.id
            ? '<button class="studio-iconbtn danger wide" data-vact="del" data-v="' + escHtml(it.id) + '">Delete for good</button>'
            : '<button class="studio-iconbtn" data-vact="del" data-v="' + escHtml(it.id) + '" aria-label="Delete">' + icon('trash') + '</button>')
          + '</span></div>';
      }
      if (!items.length && !running()) h += '<div class="studio-video-ds">' + (S.galleryFilter === 'pinned' ? 'Nothing pinned yet.' : 'No clips yet.') + '</div>';
      return h + '</div>';
    }

    function shell() {
      return '<div class="studio-video">'
        + '<div data-vregion="top">' + viewTop() + '</div>'
        + '<div class="studio-cols">'
        + '<div class="studio-form"><div class="studio-form-scroll" data-vregion="form">' + viewForm() + '</div>'
        + '<div data-vregion="picker">' + viewPicker() + '</div>'
        + '<div class="studio-foot" data-vregion="foot">' + viewFoot() + '</div></div>'
        + '<div class="studio-stage"><div class="studio-stage-main" data-vregion="stage">' + viewStage() + '</div>'
        + '<div class="studio-gal" data-vregion="gallery">' + viewGallery() + '</div></div>'
        + '</div></div>';
    }

    const VIEWS = { top: viewTop, form: viewForm, picker: viewPicker, foot: viewFoot, stage: viewStage, gallery: viewGallery };

    /** Repaint one region, or everything. Keeps focus and caret in the prompt. */
    function paint(region) {
      const root = S.root;
      if (!root || !S.shown) return;
      if (region === 'picker-list') {
        const l = root.querySelector('.studio-video-plist');
        if (l) l.innerHTML = viewPickerList();
        return;
      }
      if (!region) {
        const a = g.document && g.document.activeElement;
        const keep = a && root.contains(a) && a.getAttribute && a.getAttribute('data-vfield');
        const sel = keep && typeof a.selectionStart === 'number' ? [a.selectionStart, a.selectionEnd] : null;
        root.innerHTML = shell();
        if (keep) {
          const n = root.querySelector('[data-vfield="' + keep + '"]');
          if (n) { n.focus(); if (sel && n.setSelectionRange) n.setSelectionRange(sel[0], sel[1]); }
        }
        return;
      }
      const host = root.querySelector('[data-vregion="' + region + '"]');
      if (!host) return;
      if (region === 'form') {
        const a = g.document && g.document.activeElement;
        if (a && host.contains(a) && a.tagName === 'TEXTAREA') {
          /* Typing in the prompt: leave the textarea alone, repaint around it. */
          const ta = a; const val = ta.value; const s0 = ta.selectionStart, s1 = ta.selectionEnd;
          host.innerHTML = viewForm();
          const n = host.querySelector('[data-vfield="' + ta.getAttribute('data-vfield') + '"]');
          if (n) { n.value = val; n.focus(); n.setSelectionRange(s0, s1); }
          return;
        }
      }
      host.innerHTML = VIEWS[region]();
      if (region === 'picker' && S.pickerOpen) { const q = host.querySelector('[data-vfield="pickerq"]'); if (q) q.focus(); }
    }

    const page = {
      title: 'Video',
      icon: 'play',
      render(rootEl) {
        if (S.root !== rootEl) { S.root = rootEl; bind(rootEl); }
        S.shown = true;
        paint();
        if (!S.catalog) loadCatalog();
        loadGallery(); loadOutDir(); recoverJob();
      },
      onEvent(ev) {
        const job = ev && ev.job ? ev.job : ev;
        if (job && job.kind === KIND) onJob(job);
      },
      onShow() {
        S.shown = true;
        if (S.root) paint();
        if (S.job && BR()) BR().job(KIND, S.job.id).then((r) => { if (r && r.ok && r.data) onJob(r.data); });
        loadGallery();
      },
      onHide() { S.shown = false; S.pickerOpen = false; S.libraryOpen = false; },
      focusFile,
      _state: S,
    };
    return page;
  }

  /* ============================================================
     registration
     ============================================================ */

  const api = Object.assign({ createPage }, helpers);
  g.StudioVideo = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  let tries = 0;
  function register() {
    const st = g.STUDIO;
    if (st && typeof st.register === 'function') {
      if (!(st.pages && st.pages[KIND])) st.register(KIND, createPage());
      return;
    }
    /* The shell may load after this file: wait for it (about 10 s at most). */
    if (tries++ < 200 && typeof g.setTimeout === 'function') g.setTimeout(register, 50);
  }
  if (typeof g.document !== 'undefined' || g.STUDIO) register();
})(typeof window !== 'undefined' ? window : globalThis);
