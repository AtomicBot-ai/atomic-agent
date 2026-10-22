/* Studio › Images: state, BR.studio calls and the page's verbs. The HTML is
   images-view.js, the pure rules images-logic.js; the shell (shell.js) gives
   this page its root, its job events and its clicks (`studio:images:<verb>`).

   The form is remembered per mode in localStorage (`atag.studio.images`), the
   same per-viewer store the window keeps its theme and last Settings section
   in; pictures and paths of sources are not (a source is picked again). */
(function () {
  const KEY = 'atag.studio.images';
  const PAGE = 50;
  const FULL_KEEP = 6;
  const br = () => (window.atomic && window.atomic.studio) || null;

  const IM = {
    root: null, shown: false,
    catalog: null, catLoading: false, catErr: null, model: null,
    form: blankForm(), saved: loadSaved(),
    job: null, jobCount: 1, jobErr: null, lastReq: null, starting: false, formMsg: '',
    items: [], total: 0, hasMore: false, filter: 'all', galLoading: false, galErr: null,
    sel: null, recipe: false, delArmed: null, picking: null,
    price: null, priceKey: '', pop: null, modelQ: '', adv: false, modeWhy: null,
    dir: '', focusPath: null,
    chatItem: null,   // a picture opened from a chat that Studio did not make ("From chat")
  };
  /* key → {state:'loading'|'ok'|'fail', url}. Thumbnails stay; full pictures only the last few. */
  const PICS = new Map();
  const FULL = [];
  /* Pictures opened from a chat: read through the chat's reader (BR.imageDataUrl), not Studio's. */
  const CHAT = new Set();
  /* Sources the person dropped or pasted: key → data URL (they have no path main would take). */
  const LOCAL = new Map();
  let localSeq = 0;

  function blankForm() {
    return {prompt: '', mode: 'create', modelId: null, provider: null, aspect: '', resolution: '', size: '', count: 1,
      negative: '', steps: null, cfg: null, guidance: null, strength: null, seed: '', seedLocked: false,
      source: null, mask: null, refs: []};
  }
  function loadSaved() {
    try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); return v && typeof v === 'object' ? v : {modes: {}}; } catch (e) { return {modes: {}}; }
  }
  /* Everything but the pictures, under its mode; the model and mode for the next launch. */
  let saveT = 0;
  function save() {
    clearTimeout(saveT);
    saveT = setTimeout(() => {
      const f = IM.form;
      const keep = {};
      for (const k of ['prompt', 'aspect', 'resolution', 'size', 'count', 'negative', 'steps', 'cfg', 'guidance', 'strength', 'seed', 'seedLocked', 'modelId', 'provider']) keep[k] = f[k];
      IM.saved.modes = IM.saved.modes || {};
      IM.saved.modes[f.mode] = keep;
      IM.saved.last = {mode: f.mode, modelId: f.modelId, provider: f.provider};
      try { localStorage.setItem(KEY, JSON.stringify(IM.saved)); } catch (e) { /* no storage: remembered for this launch */ }
    }, 300);
  }

  /* ---------- painting ---------- */

  const part = (name) => IM.root && IM.root.querySelector('[data-part="' + name + '"]');

  function paint() {
    if (!IM.root) return;
    IM.root.innerHTML = simgvPage(IM);
    hydrate(IM.root);
  }
  function paintForm() {
    const el = part('form');
    if (!el) return;
    const scroll = el.querySelector('.st-form-scroll');
    const top = scroll ? scroll.scrollTop : 0;
    const a = document.activeElement;
    const focusId = a && el.contains(a) && a.id ? a.id : null;
    const caret = focusId && typeof a.selectionStart === 'number' ? [a.selectionStart, a.selectionEnd] : null;
    el.innerHTML = simgvForm(IM);
    const s2 = el.querySelector('.st-form-scroll');
    if (s2) s2.scrollTop = top;
    if (focusId) {
      const n = document.getElementById(focusId);
      if (n) { n.focus(); if (caret) try { n.setSelectionRange(caret[0], caret[1]); } catch (e) { /* not a text field */ } }
    }
    hydrate(el);
  }
  function paintFoot() { const el = IM.root && IM.root.querySelector('[data-foot]'); if (el) el.innerHTML = simgvFoot(IM); }
  function paintStage() { const el = part('stage'); if (el) { el.innerHTML = simgvStage(IM); hydrate(el); } }
  function paintGallery() { const el = part('gallery'); if (el) { el.innerHTML = simgvGallery(IM); hydrate(el); } }
  function paintPop() {
    const el = part('pop');
    if (!el) return;
    const q = document.activeElement && document.activeElement.id === 'sti-mq';
    el.innerHTML = simgvPop(IM);
    if (IM.pop) {
      const field = IM.root.querySelector('.st-model');
      const pop = el.querySelector('.st-pop');
      if (field && pop) {
        const r = field.getBoundingClientRect(), base = IM.root.querySelector('.st-cols').getBoundingClientRect();
        pop.style.left = Math.round(r.right - base.left + 8) + 'px';
        pop.style.bottom = Math.max(8, Math.round(base.bottom - r.bottom)) + 'px';
      }
      const inp = el.querySelector('#sti-mq');
      if (inp && (q || !IM.modelQ)) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
    }
    const field = IM.root.querySelector('.st-model');
    if (field) { field.classList.toggle('open', IM.pop === 'model'); field.setAttribute('aria-expanded', String(IM.pop === 'model')); }
  }
  function paintAll() { paintForm(); paintStage(); paintGallery(); paintPop(); }

  /* ---------- pictures (data: URLs from main) ---------- */

  function picFor(key, full) {
    let st = PICS.get(key);
    if (st) return st;
    st = {state: 'loading', url: ''};
    PICS.set(key, st);
    const done = () => { if (IM.root) hydrate(IM.root); };
    if (LOCAL.has(key)) { st.state = 'ok'; st.url = LOCAL.get(key); return st; }
    const s = br();
    const a = window.atomic;
    const fromChat = CHAT.has(key);
    if (fromChat ? !(a && a.imageDataUrl) : !(s && s.preview)) { st.state = 'fail'; return st; }
    // Studio answers {ok, data:{ok, dataUrl}}; the chat's reader {ok, dataUrl}.
    Promise.resolve(fromChat ? a.imageDataUrl(key) : s.preview(key)).then((r) => {
      const d = fromChat ? r : r && r.ok ? r.data : null;
      if (d && d.ok && typeof d.dataUrl === 'string') { st.state = 'ok'; st.url = d.dataUrl; } else st.state = 'fail';
      if (full) {
        FULL.push(key);
        while (FULL.length > FULL_KEEP) PICS.delete(FULL.shift());
      }
      done();
    }, () => { st.state = 'fail'; done(); });
    return st;
  }

  /** Fill the empty `data-pic` slots under `el` with their pictures. */
  function hydrate(el) {
    el.querySelectorAll('[data-pic]').forEach((slot) => {
      const key = slot.dataset.pic;
      const st = picFor(key, slot.dataset.full === '1');
      if (st.state === 'fail') { slot.classList.add('nopic'); return; }
      if (st.state !== 'ok') { slot.classList.add('loading'); return; }
      slot.classList.remove('loading');
      const have = slot.querySelector(':scope > img.st-img');
      if (have && have.dataset.src === key) return;
      if (have) have.remove();
      const img = new Image();
      img.className = 'st-img';
      img.alt = '';
      img.draggable = false;
      img.dataset.src = key;
      img.src = st.url;
      slot.insertBefore(img, slot.firstChild);
    });
  }

  /* ---------- catalog, price, gallery ---------- */

  function chooseModel(m) {
    IM.model = m;
    const f = IM.form;
    f.modelId = m ? m.id : null;
    f.provider = m ? m.provider : null;
    IM.form = simgNormalize(Object.assign({}, f, m ? simgModelDefaults(m) : {}, keepFrom(f)), m);
  }
  /** What survives a model change: the person's words and inputs, not the model's knobs. */
  function keepFrom(f) {
    return {prompt: f.prompt, mode: f.mode, count: f.count, negative: f.negative, seed: f.seed, seedLocked: f.seedLocked,
      source: f.source, mask: f.mask, refs: f.refs, aspect: f.aspect, modelId: f.modelId, provider: f.provider};
  }

  function loadCatalog() {
    const s = br();
    if (!s || !s.catalog || IM.catLoading) return;
    IM.catLoading = true;
    paintForm();
    Promise.resolve(s.catalog('image')).then((r) => {
      IM.catLoading = false;
      if (!r || !r.ok) { IM.catErr = (r && r.error) || {message: 'Could not read the models.'}; paintForm(); return; }
      IM.catalog = r.data;
      IM.catErr = null;
      const last = IM.saved.last || {};
      const mode = last.mode || 'create';
      const kept = (IM.saved.modes || {})[mode] || {};
      const m = simgFindModel(IM.catalog, kept.modelId || last.modelId, kept.provider || last.provider) || simgDefaultModel(IM.catalog);
      IM.model = m;
      IM.form = simgNormalize(Object.assign(blankForm(), m ? simgModelDefaults(m) : {}, kept, {mode, source: IM.form.source, mask: IM.form.mask, refs: IM.form.refs,
        prompt: IM.form.prompt || kept.prompt || '', modelId: m && m.id, provider: m && m.provider}), m);
      paintForm();
      refreshPrice();
    }, () => { IM.catLoading = false; IM.catErr = {message: 'Could not read the models.'}; paintForm(); });
  }

  let priceT = 0;
  function refreshPrice() {
    clearTimeout(priceT);
    const p = simgPriceParams(IM.form, IM.model);
    const key = p ? IM.model.id + '|' + JSON.stringify(p) : '';
    if (key === IM.priceKey) return;
    IM.priceKey = key;
    if (!p) { IM.price = null; paintFoot(); return; }
    priceT = setTimeout(() => {
      const s = br();
      if (!s || !s.price) return;
      Promise.resolve(s.price(IM.model.id, p)).then((r) => {
        if (IM.priceKey !== key) return;
        IM.price = r && r.ok ? r.data : null;
        paintFoot();
      }, () => undefined);
    }, 250);
  }

  function loadGallery(more) {
    const s = br();
    if (!s || !s.gallery || IM.galLoading) return;
    IM.galLoading = true;
    if (!more) paintGallery();
    Promise.resolve(s.gallery('image', {offset: more ? IM.items.length : 0, limit: PAGE})).then((r) => {
      IM.galLoading = false;
      if (!r || !r.ok) { IM.galErr = (r && r.error) || {message: 'Could not read the gallery.'}; paintGallery(); return; }
      IM.galErr = null;
      const got = r.data.items || [];
      IM.items = more ? IM.items.concat(got.filter((x) => !IM.items.some((y) => y.id === x.id))) : mergeFresh(got);
      IM.total = r.data.total || IM.items.length;
      IM.hasMore = !!r.data.hasMore;
      if (IM.focusPath) focusFile(IM.focusPath);
      paintGallery();
    }, () => { IM.galLoading = false; paintGallery(); });
  }
  /* A first page keeps outputs that landed while it was being read. */
  function mergeFresh(got) {
    const ids = new Set(got.map((x) => x.id));
    return IM.items.filter((x) => !ids.has(x.id) && Date.now() - (x.createdAtMs || 0) < 60000).concat(got);
  }

  function loadDir() {
    const s = br();
    if (!s || !s.outputDir) return;
    Promise.resolve(s.outputDir('image')).then((r) => { if (r && r.ok && r.data) { IM.dir = r.data.path || ''; const t = IM.root && IM.root.querySelector('.st-pill span'); if (t) t.textContent = IM.dir.replace(/^\/Users\/[^/]+/, '~'); } }, () => undefined);
  }

  /* ---------- jobs ---------- */

  const isLive = (j) => j && (j.state === 'queued' || j.state === 'generating');

  async function generate() {
    if (isLive(IM.job) || IM.starting) return;
    const b = simgBuildRequest(IM.form, IM.model);
    if (!b.ok) { IM.formMsg = b.message; paintFoot(); return; }
    const s = br();
    if (!s || !s.generateImage) { IM.formMsg = 'Studio needs a newer app build.'; paintFoot(); return; }
    IM.formMsg = '';
    IM.starting = true;
    IM.pop = null;
    paintFoot(); paintPop();
    IM.lastReq = b.req;
    const r = await Promise.resolve(s.generateImage(b.req)).catch(() => null);
    IM.starting = false;
    if (!r || !r.ok) {
      IM.jobErr = (r && r.error) || {code: 'FAILED', message: 'Studio could not start that.'};
      paintStage(); paintFoot();
      return;
    }
    IM.job = r.data.job || {id: r.data.jobId, kind: 'image', state: 'queued', cloud: b.req.provider !== 'local', model: b.req.model, progress: null, outputs: []};
    IM.jobCount = b.req.count || 1;
    IM.jobErr = null;
    IM.recipe = false;
    paintStage(); paintFoot(); paintGallery();
  }

  function stop() {
    const s = br();
    if (!IM.job || !s || !s.cancel) return;
    Promise.resolve(s.cancel('image', IM.job.id)).then((r) => {
      if (!r || !r.ok) toast('Could not stop it', (r && r.error && r.error.message) || '', 'bad');
    });
  }

  /** Patch the progress card in place: a rebuild per event would restart its animations. */
  function patchProgress() {
    const card = IM.root && IM.root.querySelector('.st-prog[data-prog="' + CSS.escape(IM.job.id) + '"]');
    if (!card) { paintStage(); return; }
    const p = simgProgress(IM.job);
    const set = (k, v) => { const n = card.querySelector('[data-p="' + k + '"]'); if (n && n.textContent !== v) n.textContent = v; };
    set('title', p.title); set('line', p.line); set('eta', p.eta);
    const bar = card.querySelector('[data-p="bar"]');
    if (bar) bar.style.width = Math.round(p.fraction * 100) + '%';
    const ph = card.querySelector('[data-p="phases"]');
    if (ph && ph.dataset.at !== String(p.phaseIndex)) { ph.dataset.at = String(p.phaseIndex); ph.innerHTML = simgPhaseRows(p.phaseIndex); }
  }

  function onEvent(job) {
    if (!job || job.kind !== 'image') return;
    const mine = IM.job && IM.job.id === job.id;
    if (!mine && isLive(job) && !isLive(IM.job)) {
      // A job this app started before a window reload: its card again.
      IM.job = job; IM.jobCount = (job.progress && job.progress.batchSize) || 1;
      if (IM.shown) { paintStage(); paintFoot(); paintGallery(); }
      return;
    }
    if (!mine) {
      if (job.state === 'completed') addOutputs(job.outputs, false);
      return;
    }
    IM.job = job;
    if (isLive(job)) { if (IM.shown) patchProgress(); return; }
    if (job.state === 'completed') {
      addOutputs(job.outputs, true);
      IM.jobErr = null;
    } else if (job.state === 'cancelled' || (job.error && job.error.code === 'CANCELLED')) {
      if (typeof toast === 'function') toast('Stopped', '');
    } else {
      IM.jobErr = job.error || {code: 'FAILED', message: 'That did not work.'};
      if (!IM.shown && typeof toast === 'function') toast('An image did not finish', IM.jobErr.message, 'bad');
    }
    if (job.state === 'completed' && !IM.shown && typeof toast === 'function') toast('Images are ready', 'Open Studio › Images to see them');
    if (IM.shown) { paintStage(); paintFoot(); paintGallery(); }
  }

  function addOutputs(outs, select) {
    const list = Array.isArray(outs) ? outs : [];
    if (!list.length) return;
    const fresh = list.filter((x) => !IM.items.some((y) => y.id === x.id));
    IM.items = fresh.concat(IM.items);
    IM.total += fresh.length;
    if (select) { IM.sel = list[0].id; IM.delArmed = null; }
    if (IM.shown && !select) paintGallery();
  }

  /* ---------- sources ---------- */

  function sourceFromItem(x) {
    return {path: x.path, key: x.thumbnailPath || x.path, name: baseName(x.path), note: (x.width && x.height ? x.width + ' × ' + x.height + ' · ' : '') + 'from your gallery'};
  }
  function baseName(p) { return String(p || '').split(/[\\/]/).pop(); }

  function setSlot(slot, src) {
    if (slot === 'ref') {
      const max = Math.max(0, ((IM.model && IM.model.maxInputImages) || 16) - 1);
      if (IM.form.refs.length >= max) { toast('That is the most this model takes', '', 'bad'); return; }
      IM.form.refs = IM.form.refs.concat([src]);
    } else IM.form[slot] = src;
    IM.picking = null;
    paintForm(); paintGallery();
  }

  function readFile(file) {
    return new Promise((resolve) => {
      if (!file || !/^image\/(png|jpe?g|webp)$/i.test(file.type || '')) { resolve(null); return; }
      if (file.size > 48 * 1024 * 1024) { toast('That picture is too big', 'Up to 48 MB', 'bad'); resolve(null); return; }
      const fr = new FileReader();
      fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : null);
      fr.onerror = () => resolve(null);
      fr.readAsDataURL(file);
    });
  }
  async function takeFiles(files, slot) {
    for (const file of files) {
      const url = await readFile(file);
      if (!url) continue;
      const key = 'local:' + (++localSeq);
      LOCAL.set(key, url);
      setSlot(slot, {base64: url, key, name: file.name || 'Pasted image', note: 'from your Mac'});
      if (slot !== 'ref') break;
    }
  }
  /** Where a drop or paste goes in the current mode. */
  function dropSlot(target) {
    const z = target && target.closest && target.closest('[data-drop]');
    if (z) return z.dataset.drop;
    if (IM.form.mode === 'create') return null;
    if (IM.form.mode === 'reference' && IM.form.source) return 'ref';
    return 'source';
  }

  async function pickFiles(slot) {
    const s = br();
    if (!s || !s.pickImages) return;
    const r = await Promise.resolve(s.pickImages(slot === 'ref')).catch(() => null);
    const list = r && r.ok && Array.isArray(r.data) ? r.data : [];
    for (const f of list) {
      setSlot(slot, {path: f.path, key: f.path, name: f.name, note: 'from your Mac'});
      if (slot !== 'ref') break;
    }
  }

  /* ---------- result actions ---------- */

  const selItem = () => IM.items.find((x) => x.id === IM.sel) || (IM.chatItem && IM.chatItem.id === IM.sel ? IM.chatItem : null);

  async function fullDataUrl(item) {
    if (item.fromChat) {
      const a = window.atomic;
      const r = a && a.imageDataUrl ? await Promise.resolve(a.imageDataUrl(item.path)).catch(() => null) : null;
      return r && r.ok ? r : null;
    }
    const s = br();
    const r = s && s.preview ? await Promise.resolve(s.preview(item.path)).catch(() => null) : null;
    const d = r && r.ok ? r.data : null;
    return d && d.ok ? d : null;
  }
  async function asBlob(dataUrl, png) {
    // Not fetch(): the window's CSP (connect-src 'none') refuses even a data: URL.
    const got = STUDIO.dataUrlToBytes(dataUrl);
    if (!got) throw new Error('Not a picture');
    const blob = new Blob([got.bytes], {type: got.type});
    if (!png || blob.type === 'image/png') return blob;
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = dataUrl; });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    return new Promise((res) => c.toBlob(res, 'image/png'));
  }

  async function copyImage(item) {
    const d = await fullDataUrl(item);
    if (!d) { toast('Could not copy', 'The picture is no longer there.', 'bad'); return; }
    try {
      const blob = await asBlob(d.dataUrl, true);
      await navigator.clipboard.write([new ClipboardItem({'image/png': blob})]);
      toast('Image copied', '');
    } catch (e) { toast('Could not copy', String((e && e.message) || e), 'bad'); }
  }

  /* The shell's one way into the chat (shell.js sendToChat), shared with Video. */
  function sendToChat(item) {
    Promise.resolve(STUDIO.sendToChat({path: item.path, name: baseName(item.path)})).then((ok) => {
      if (!ok) toast('Could not send it', 'The picture is no longer there.', 'bad');
    });
  }

  function restore(item) {
    const r = simgRecipeToForm(item);
    const m = (r.modelId && simgFindModel(IM.catalog, r.modelId, r.provider)) || IM.model;
    const next = Object.assign({}, IM.form, r);
    delete next.modelId; delete next.provider;
    IM.model = m;
    next.modelId = m ? m.id : null; next.provider = m ? m.provider : null;
    IM.form = simgNormalize(next, m);
    if (r.modelId && m && m.id !== r.modelId) toast('Settings restored', 'That model is not listed now, so the current one stays');
    else toast('Settings restored', '');
    save(); paintForm(); refreshPrice();
  }

  function useAsSource(item) {
    const can = (IM.model && IM.model.modes) || [];
    const mode = can.includes('edit') ? 'edit' : can.find((x) => x !== 'create');
    if (mode) switchMode(mode);
    IM.form.source = sourceFromItem(item);
    if (!mode) toast('Source added', 'Pick a model that can edit pictures to use it');
    paintForm();
  }

  function switchMode(mode) {
    if (IM.form.mode === mode) return;
    save();
    const kept = (IM.saved.modes || {})[mode] || {};
    const carry = {prompt: IM.form.prompt, source: IM.form.source, mask: IM.form.mask, refs: IM.form.refs, modelId: IM.form.modelId, provider: IM.form.provider};
    IM.form = simgNormalize(Object.assign({}, IM.form, kept, carry, {mode,
      aspect: mode === 'create' ? (kept.aspect && kept.aspect !== 'source' ? kept.aspect : IM.form.aspect) : (kept.aspect || 'source')}), IM.model);
    if (IM.form.mode !== mode) IM.form.mode = mode;
    IM.formMsg = '';
  }

  function focusFile(path) {
    IM.focusPath = path;
    const hit = IM.items.find((x) => x.path === path || x.thumbnailPath === path);
    if (!hit) {
      if (IM.galLoading) return;
      if (IM.hasMore) { loadGallery(true); return; }
      IM.focusPath = null;
      showFromChat(path);
      return;
    }
    IM.focusPath = null;
    IM.sel = hit.id; IM.filter = 'all'; IM.recipe = false; IM.jobErr = null;
    if (IM.shown) { paintStage(); paintGallery(); scrollThumb(); }
  }
  /** A picture Studio did not make (an agent tool saved it in the working folder), shown on its own. */
  function showFromChat(path) {
    CHAT.add(path);
    PICS.delete(path);   // read again: the agent may have written it anew
    IM.chatItem = {id: 'chat:' + path, path, fromChat: true, prompt: '', createdAtMs: Date.now(), pinned: false};
    IM.sel = IM.chatItem.id; IM.recipe = false; IM.delArmed = null;
    if (!isLive(IM.job)) IM.jobErr = null;
    if (IM.shown) { paintStage(); paintGallery(); }
  }
  function scrollThumb() {
    const t = IM.root && IM.root.querySelector('.st-th.on');
    if (t && t.scrollIntoView) t.scrollIntoView({block: 'nearest'});
  }

  /* ---------- verbs ---------- */

  function verb(v) {
    const i = v.indexOf(':');
    const k = i < 0 ? v : v.slice(0, i), a = i < 0 ? '' : v.slice(i + 1);
    const item = selItem();
    const s = br();
    switch (k) {
      case 'generate': generate(); return;
      case 'stop': stop(); return;
      case 'retry': IM.jobErr = null; generate(); return;
      // ATO-830: the rate-limit card's other model: switch to it and send the same form again.
      case 'trymodel': { const bar = a.indexOf('|'); const m = simgFindModel(IM.catalog, a.slice(bar + 1), a.slice(0, bar)); IM.jobErr = null; if (m) { chooseModel(m); save(); paintForm(); refreshPrice(); generate(); } else paintStage(); return; }
      case 'dismiss': IM.jobErr = null; paintStage(); return;
      case 'settings': STUDIO.openSettings('openrouter'); return;
      case 'mode': IM.modeWhy = null; switchMode(a); save(); paintForm(); refreshPrice(); return;
      case 'modewhy': IM.modeWhy = a; paintForm(); return;
      case 'aspect': IM.form.aspect = a; save(); paintForm(); return;
      case 'count': IM.form.count = Math.min(Math.max(1, IM.form.count + Number(a)), Math.max(1, (IM.model && IM.model.maxCount) || 1)); save(); paintForm(); refreshPrice(); return;
      case 'adv': IM.adv = !IM.adv; paintForm(); return;
      case 'seedlock': IM.form.seedLocked = !IM.form.seedLocked; if (IM.form.seedLocked && IM.form.seed === '') IM.form.seed = String(randSeed()); save(); paintForm(); return;
      case 'seednew': IM.form.seed = String(randSeed()); IM.form.seedLocked = true; save(); paintForm(); return;
      case 'pop': IM.pop = IM.pop === a ? null : a; IM.modelQ = ''; paintPop(); return;
      case 'model': {
        const bar = a.indexOf('|');
        const m = simgFindModel(IM.catalog, a.slice(bar + 1), a.slice(0, bar));
        if (m) chooseModel(m);
        IM.modeWhy = null; IM.pop = null; save(); paintForm(); paintPop(); refreshPrice();
        return;
      }
      case 'idea': IM.form.prompt = a; paintForm(); { const t = document.getElementById('sti-prompt'); if (t) t.focus(); } save(); return;
      case 'clear': if (a === 'mask') IM.form.mask = null; else IM.form.source = null; paintForm(); return;
      case 'unref': IM.form.refs = IM.form.refs.filter((_, n) => n !== Number(a)); paintForm(); return;
      case 'pick': pickFiles(a); return;
      case 'fromlib': IM.picking = a || null; paintForm(); paintGallery(); return;
      case 'filter': IM.filter = a === 'pinned' ? 'pinned' : 'all'; paintGallery(); return;
      case 'more': loadGallery(true); return;
      case 'sel': {
        const x = IM.items.find((y) => y.id === a);
        if (!x) return;
        if (IM.picking) { setSlot(IM.picking, sourceFromItem(x)); return; }
        IM.sel = a; IM.delArmed = null; if (!isLive(IM.job)) IM.jobErr = null;
        paintStage(); paintGallery();
        return;
      }
      case 'folder':
        if (s && s.chooseOutputDir) Promise.resolve(s.chooseOutputDir('image')).then((r) => {
          if (r && r.ok && r.data) { IM.dir = r.data.path; if (window.STUDIO) STUDIO.refreshDirs(); paint(); loadGallery(false); }
        });
        return;
    }
    if (!item) return;
    if (item.fromChat) {
      // Not Studio's file: the chat's own Save As… and Reveal (main checks it is a picture again).
      const a = window.atomic || {};
      switch (k) {
        case 'saveas':
          if (a.imageSaveAs) Promise.resolve(a.imageSaveAs(item.path)).then((r) => {
            if (r && r.ok) toast('Saved', r.path || '');
            else if (!r || r.reason !== 'canceled') toast('Could not save it', 'The picture is no longer there.', 'bad');
          });
          return;
        case 'reveal':
          if (a.imageReveal) Promise.resolve(a.imageReveal(item.path)).then((r) => { if (!r || !r.ok) toast('Could not show it', 'The picture is no longer there.', 'bad'); });
          return;
        case 'copy': copyImage(item); return;
        case 'tochat': sendToChat(item); return;
      }
      return;
    }
    switch (k) {
      case 'recipe': IM.recipe = !IM.recipe; paintStage(); return;
      case 'pin':
        Promise.resolve(s.pin('image', item.id, !item.pinned)).then((r) => {
          if (r && r.ok && r.data) Object.assign(item, r.data); else if (r && r.ok) item.pinned = !item.pinned;
          else toast('Could not pin it', (r && r.error && r.error.message) || '', 'bad');
          paintStage(); paintGallery();
        });
        return;
      case 'delete':
        if (IM.delArmed !== item.id) {
          IM.delArmed = item.id; paintStage();
          setTimeout(() => { if (IM.delArmed === item.id) { IM.delArmed = null; paintStage(); } }, 3500);
          return;
        }
        IM.delArmed = null;
        Promise.resolve(s.galleryDelete('image', [item.id])).then((r) => {
          if (!r || !r.ok) { toast('Could not delete it', (r && r.error && r.error.message) || '', 'bad'); return; }
          const at = IM.items.indexOf(item);
          IM.items = IM.items.filter((x) => x !== item);
          IM.total = Math.max(0, IM.total - 1);
          const next = IM.items[Math.min(at, IM.items.length - 1)];
          IM.sel = next ? next.id : null;
          paintStage(); paintGallery();
        });
        return;
      case 'saveas':
        Promise.resolve(s.saveAs(item.path)).then((r) => {
          if (r && r.ok && r.data && r.data.saved) toast('Saved', r.data.path || '');
          else if (!r || !r.ok) toast('Could not save it', (r && r.error && r.error.message) || '', 'bad');
        });
        return;
      case 'reveal':
        Promise.resolve(s.revealInFinder(item.path)).then((r) => { if (!r || !r.ok) toast('Could not show it', (r && r.error && r.error.message) || '', 'bad'); });
        return;
      case 'copy': copyImage(item); return;
      case 'usesource': useAsSource(item); return;
      case 'restore': restore(item); return;
      case 'tochat': sendToChat(item); return;
    }
  }

  function randSeed() { return Math.floor(Math.random() * 2147483647); }

  /* ---------- DOM listeners on the page's root ---------- */

  function wire(root) {
    root.addEventListener('input', (e) => {
      const t = e.target, f = IM.form;
      if (t.id === 'sti-prompt') {
        f.prompt = t.value;
        if (IM.formMsg) { IM.formMsg = ''; paintFoot(); }
        save();
        return;
      }
      if (t.id === 'sti-neg') { f.negative = t.value; save(); return; }
      if (t.id === 'sti-seed') { f.seed = t.value.replace(/\D/g, '').slice(0, 10); f.seedLocked = f.seed !== ''; if (t.value !== f.seed) t.value = f.seed; save(); return; }
      if (t.id === 'sti-mq') { IM.modelQ = t.value; paintPop(); return; }
      const sliders = {'sti-steps': 'steps', 'sti-cfg': 'cfg', 'sti-guid': 'guidance', 'sti-str': 'strength'};
      if (sliders[t.id]) {
        f[sliders[t.id]] = Number(t.value);
        const v = root.querySelector('[data-val="' + t.id + '"]');
        if (v) v.textContent = t.value;
        save();
      }
    });
    root.addEventListener('change', (e) => {
      const t = e.target;
      if (t.id === 'sti-res') { IM.form.resolution = t.value; save(); refreshPrice(); }
      if (t.id === 'sti-size') { IM.form.size = t.value; save(); }
    });
    // A click outside the model picker closes it (the picker's own rows act through data-act).
    root.addEventListener('mousedown', (e) => {
      if (IM.pop && !e.target.closest('.st-pop') && !e.target.closest('.st-model')) { IM.pop = null; paintPop(); }
    });
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    root.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); e.stopPropagation();
      const slot = dropSlot(e.target);
      e.dataTransfer.dropEffect = slot ? 'copy' : 'none';
      root.querySelectorAll('[data-drop]').forEach((z) => z.classList.toggle('over', !!slot && z.dataset.drop === (slot === 'ref' ? 'source' : slot)));
    });
    root.addEventListener('dragleave', (e) => { if (!e.relatedTarget || !root.contains(e.relatedTarget)) root.querySelectorAll('[data-drop].over').forEach((z) => z.classList.remove('over')); });
    root.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); e.stopPropagation();
      root.querySelectorAll('[data-drop].over').forEach((z) => z.classList.remove('over'));
      const slot = dropSlot(e.target);
      if (!slot) { toast('Pick a mode that uses a picture', 'Edit, Reference and the others take one', 'bad'); return; }
      takeFiles(Array.from(e.dataTransfer.files || []), slot);
    });
    root.addEventListener('paste', (e) => {
      const files = Array.from((e.clipboardData && e.clipboardData.files) || []).filter((f) => /^image\//.test(f.type));
      if (!files.length) return;
      const slot = dropSlot(e.target);
      if (!slot) return;
      e.preventDefault();
      takeFiles(files, slot);
    });
  }

  function onKey(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); if (isLive(IM.job)) return true; generate(); return true; }
    if (e.key === 'Escape') {
      if (IM.pop) { IM.pop = null; paintPop(); e.preventDefault(); return true; }
      if (IM.picking) { IM.picking = null; paintForm(); paintGallery(); e.preventDefault(); return true; }
      if (IM.recipe) { IM.recipe = false; paintStage(); e.preventDefault(); return true; }
    }
    return false;
  }

  if (typeof window === 'undefined' || !window.STUDIO) return;
  STUDIO.register('images', {
    title: 'Images',
    icon: 'image',
    render(root) {
      IM.root = root;
      wire(root);
      paint();
      loadCatalog();
      loadGallery(false);
      loadDir();
    },
    onShow() {
      IM.shown = true;
      if (!IM.catalog && !IM.catLoading) loadCatalog();
      paintAll();
      const t = document.getElementById('sti-prompt');
      if (t && !IM.form.prompt) t.focus();
    },
    onHide() { IM.shown = false; IM.pop = null; IM.picking = null; },
    onEvent,
    onKey,
    act: verb,
    focusFile(path) {
      IM.filter = 'all';
      if (IM.items.some((x) => x.path === path || x.thumbnailPath === path)) { focusFile(path); return; }
      // Outside Studio's folder (an agent tool's picture): no gallery page will have it.
      if (!STUDIO.isStudioFile(path, 'image')) { IM.focusPath = null; showFromChat(path); return; }
      // Not read yet, or newer than the first page: read the first page again; its answer focuses it.
      IM.focusPath = path;
      loadGallery(false);
    },
  });
})();
