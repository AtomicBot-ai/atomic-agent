/* ---------------- ATO-2513: "Make your own pet", the dialog ----------------
   Loaded after renderer.js and pet-maker-logic.js. Opened from View ›
   Desktop Pet › Make Your Own Pet… and from the pet's own menu (main sends
   pet:openMaker). Draws only into its own #pet-maker layer and listens for
   its own `data-petm` clicks.

   - Your pets: the built-in atom and every made pet, with Use and Delete
     (Delete moves the pet's folder to the Trash).
   - Make a pet: a description, a name and a picture model (Studio's
     catalog: downloaded local models, free; cloud ones with their price on
     the Make button first). It makes four pictures one after another, the
     later ones from the first as a reference when the model takes one, so
     they look like the same pet; Stop cancels the one running and keeps
     nothing. main/pet-skins.ts keeps them in userData and the new pet shows.
   - No model ready: a pointer to Studio, where models are downloaded and the
     OpenRouter key is set. */

const PETM = {
  open: false, loading: false, phase: 'form', models: [], key: '', desc: '', name: '',
  price: undefined, error: '', detail: '', progress: '', jobId: null, stop: false,
  skins: [], selected: 'atom', loadError: '',
};

function petmBR() { return typeof BR !== 'undefined' && BR && BR.pet && BR.pet.skins && BR.studio ? BR : null; }
function petmEsc(s) { return typeof esc === 'function' ? esc(s) : String(s); }
function petmOption() { return PETM.models.find((m) => m.key === PETM.key) || PETM.models[0] || null; }

function petmSkinsHTML() {
  const row = (id, name, preview, used) => '<div class="petm-pet">'
    + (preview ? '<img class="petm-thumb" alt="" src="' + petmEsc(preview) + '">' : '<span class="petm-thumb petm-atom" aria-hidden="true"></span>')
    + '<span class="petm-name">' + petmEsc(name) + '</span>'
    + (used ? '<span class="petm-used">In use</span>' : '<button class="btn xs" type="button" data-petm="use:' + petmEsc(id) + '">Use</button>')
    + (id === 'atom' ? '' : '<button class="btn xs" type="button" data-petm="del:' + petmEsc(id) + '" aria-label="Delete ' + petmEsc(name) + '">Delete</button>')
    + '</div>';
  return '<div class="petm-pets" role="list" aria-label="Your pets">'
    + row('atom', 'Atom (built in)', null, PETM.selected === 'atom')
    + PETM.skins.map((s) => row(s.id, s.name, s.preview, PETM.selected === s.id)).join('')
    + '</div>';
}

function petmFormHTML() {
  if (PETM.loading) return '<p class="tk-help" role="status">Looking for picture models…</p>';
  if (PETM.loadError) {
    return '<p class="tk-help tk-help--err" role="alert">Could not reach the picture engine.</p>'
      + '<details class="petm-details"><summary>Details</summary>' + petmEsc(PETM.loadError) + '</details>'
      + '<button class="btn sm" type="button" data-petm="retry">Try again</button>';
  }
  if (!PETM.models.length) {
    return '<p class="tk-help">No picture model is ready. Download a local model (free) or add an OpenRouter key in Studio, then come back.</p>'
      + '<button class="btn sm" type="button" data-petm="studio">Open Studio</button>';
  }
  const making = PETM.phase === 'making';
  const opt = petmOption();
  const price = petmPrice(opt, opt && opt.free ? null : PETM.price);
  return '<label class="tk-field"><span class="tk-lbl">Describe your pet</span>'
      + '<textarea class="tk-inp" data-petm-field="desc" rows="3" maxlength="300" placeholder="A small orange fox with big ears"' + (making ? ' disabled' : '') + '>' + petmEsc(PETM.desc) + '</textarea></label>'
    + '<label class="tk-field"><span class="tk-lbl">Name</span>'
      + '<input class="tk-inp" data-petm-field="name" maxlength="40" placeholder="My pet" value="' + petmEsc(PETM.name) + '"' + (making ? ' disabled' : '') + '></label>'
    + '<label class="tk-field"><span class="tk-lbl">Picture model</span>'
      + '<select class="tk-inp" data-petm-field="model"' + (making ? ' disabled' : '') + '>'
      + PETM.models.map((m) => '<option value="' + petmEsc(m.key) + '"' + (opt && m.key === opt.key ? ' selected' : '') + '>'
        + petmEsc(m.name + (m.free ? ' (on this computer, free)' : ' (cloud, paid)')) + '</option>').join('')
      + '</select></label>'
    + '<p class="tk-help" data-petm-price>' + petmEsc(price.line) + '</p>'
    + (PETM.progress ? '<p class="tk-help" role="status">' + petmEsc(PETM.progress) + '</p>' : '')
    + (PETM.error ? '<p class="tk-help tk-help--err" role="alert">' + petmEsc(PETM.error) + '</p>'
      + (PETM.detail ? '<details class="petm-details"><summary>Details</summary>' + petmEsc(PETM.detail) + '</details>' : '') : '');
}

function petmHTML() {
  const making = PETM.phase === 'making';
  const opt = petmOption();
  const price = petmPrice(opt, opt && opt.free ? null : PETM.price);
  const canMake = !PETM.loading && !PETM.loadError && PETM.models.length > 0 && price.ready && !making;
  return '<div class="sheetwrap petm-wrap" data-petm="backdrop"><div class="sheet petm-sheet" role="dialog" aria-modal="true" aria-label="Your desktop pet">'
    + '<div class="sheethead"><span class="ttl">Your desktop pet</span>'
      + '<button class="iconbtn" type="button" data-petm="close" aria-label="Close" title="Close">' + (typeof ic === 'function' ? ic('x') : '×') + '</button></div>'
    + '<div class="petm-body">'
      + petmSkinsHTML()
      + '<h3 class="petm-h">Make a new pet</h3>'
      + petmFormHTML()
    + '</div>'
    + '<div class="sheetfoot">'
      + (making ? '<button class="btn sm" type="button" data-petm="stop">Stop</button>' : '<button class="btn sm" type="button" data-petm="close">Close</button>')
      + (PETM.models.length ? '<button class="btn btn-p sm" type="button" data-petm="make"' + (canMake ? '' : ' disabled') + '>' + petmEsc(making ? 'Making…' : price.button) + '</button>' : '')
    + '</div>'
  + '</div></div>';
}

function petmPaint() {
  const host = typeof document !== 'undefined' && document.getElementById('pet-maker');
  if (!host) return;
  const a = document.activeElement;
  const field = a && a.getAttribute ? a.getAttribute('data-petm-field') : null;
  host.innerHTML = PETM.open ? petmHTML() : '';
  const back = field && host.querySelector('[data-petm-field="' + field + '"]');
  if (back) { back.focus(); if (typeof back.setSelectionRange === 'function' && back.value != null && field !== 'model') back.setSelectionRange(back.value.length, back.value.length); }
}

async function petmSkins() {
  const br = petmBR();
  const res = br ? await br.pet.skins().catch(() => null) : null;
  if (res && Array.isArray(res.skins)) { PETM.skins = res.skins; PETM.selected = res.selected || 'atom'; }
}

async function petmLoadPrice() {
  const br = petmBR();
  const opt = petmOption();
  PETM.price = undefined;
  if (!br || !opt || opt.free) return;
  const want = opt.key;
  const res = await br.studio.price(opt.id, {kind: 'image', count: PETM_FRAMES.length, mode: 'create'}).catch(() => null);
  if (petmOption() && petmOption().key === want) { PETM.price = res && res.ok ? res.data : null; petmPaint(); }
}

async function petmOpen() {
  const br = petmBR();
  if (!br) return;
  PETM.open = true; PETM.loading = true; PETM.loadError = ''; PETM.error = ''; PETM.detail = ''; PETM.progress = '';
  petmPaint();
  await petmSkins();
  const res = await br.studio.catalog('image').catch(() => null);
  PETM.loading = false;
  if (!res || !res.ok) {
    PETM.loadError = (res && res.error && res.error.message) || 'No answer from the picture engine.';
  } else {
    PETM.models = petmModels(res.data);
    if (!PETM.models.some((m) => m.key === PETM.key)) PETM.key = PETM.models.length ? PETM.models[0].key : '';
  }
  petmPaint();
  const desc = document.querySelector('#pet-maker [data-petm-field="desc"]');
  if (desc) desc.focus();
  void petmLoadPrice();
}

function petmClose() {
  if (PETM.phase === 'making') return;
  PETM.open = false; PETM.error = ''; PETM.detail = ''; PETM.progress = '';
  petmPaint();
}

const petmSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits for one Studio job; the 2 s safety poll main runs keeps `job` fresh. */
async function petmWait(br, id) {
  for (;;) {
    if (PETM.stop) return null;
    const res = await br.studio.job('image', id).catch(() => null);
    const job = res && res.ok ? res.data : null;
    if (job && petmJobEnd(job)) return job;
    await petmSleep(1000);
  }
}

function petmFail(message, detail) {
  PETM.phase = 'form'; PETM.progress = ''; PETM.jobId = null;
  PETM.error = message; PETM.detail = detail || '';
  petmPaint();
}

async function petmMake() {
  const br = petmBR();
  const opt = petmOption();
  if (!br || !opt || PETM.phase === 'making') return;
  if (!PETM.desc.trim()) { PETM.error = 'Describe your pet first, in a few words.'; petmPaint(); return; }
  PETM.phase = 'making'; PETM.stop = false; PETM.error = ''; PETM.detail = '';
  const frames = {};
  for (let i = 0; i < PETM_FRAMES.length; i++) {
    const frame = PETM_FRAMES[i];
    PETM.progress = petmProgressLine(i, frame);
    petmPaint();
    const res = await br.studio.generateImage(petmRequest(opt, PETM.desc, frame, frames.idle || null)).catch(() => null);
    if (!res || !res.ok) return petmFail((res && res.error && res.error.message) || 'The picture could not be started.', res && res.error && res.error.details);
    PETM.jobId = res.data.jobId;
    const job = await petmWait(br, res.data.jobId);
    PETM.jobId = null;
    if (!job || petmJobEnd(job) === 'stopped') return petmFail('Stopped. Nothing was saved.');
    if (petmJobEnd(job) !== 'done') return petmFail((job.error && job.error.message) || 'The picture could not be made.', job.error && job.error.details);
    const url = petmDataUrl(await br.studio.preview(job.outputs[0].path).catch(() => null));
    if (!url) return petmFail('The picture was made but could not be read. Try again.');
    frames[frame] = url;
  }
  PETM.progress = 'Saving your pet…';
  petmPaint();
  const saved = await br.pet.saveSkin(PETM.name, frames).catch(() => null);
  if (!saved || !saved.ok) return petmFail((saved && saved.error) || 'The pet could not be saved.');
  PETM.phase = 'form'; PETM.progress = ''; PETM.desc = ''; PETM.name = '';
  await petmSkins();
  petmPaint();
  if (typeof toast === 'function') toast('Your pet is ready', saved.skin && saved.skin.name ? saved.skin.name + ' is your desktop pet now.' : '', 'ok');
}

async function petmStop() {
  const br = petmBR();
  PETM.stop = true;
  if (br && PETM.jobId) await br.studio.cancel('image', PETM.jobId).catch(() => null);
}

async function petmUse(id) {
  const br = petmBR();
  const res = br ? await br.pet.useSkin(id).catch(() => null) : null;
  if (!res || !res.ok) { PETM.error = 'That pet could not be shown.'; }
  await petmSkins();
  petmPaint();
}

async function petmDelete(id) {
  const br = petmBR();
  const res = br ? await br.pet.deleteSkin(id).catch(() => null) : null;
  if (!res || !res.ok) PETM.error = (res && res.error) || 'The pet could not be moved to the Trash.';
  await petmSkins();
  petmPaint();
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  document.addEventListener('click', (e) => {
    const t = e.target;
    const el = t && t.closest ? t.closest('[data-petm]') : null;
    if (!el) return;
    const what = el.getAttribute('data-petm');
    if (what === 'backdrop') { if (t === el) { e.preventDefault(); petmClose(); } return; }
    e.preventDefault();
    if (what === 'close') petmClose();
    else if (what === 'make') void petmMake();
    else if (what === 'stop') void petmStop();
    else if (what === 'retry') void petmOpen();
    // The window's own delegate opens Studio's Images page (studio/shell.js `studio:open:<kind>`).
    else if (what === 'studio') { petmClose(); if (typeof act === 'function') act('studio:open:images'); }
    else if (what.startsWith('use:')) void petmUse(what.slice(4));
    else if (what.startsWith('del:')) void petmDelete(what.slice(4));
  });
  document.addEventListener('input', (e) => {
    const f = e.target && e.target.getAttribute ? e.target.getAttribute('data-petm-field') : null;
    if (f === 'desc') PETM.desc = e.target.value;
    else if (f === 'name') PETM.name = e.target.value;
  });
  document.addEventListener('change', (e) => {
    const f = e.target && e.target.getAttribute ? e.target.getAttribute('data-petm-field') : null;
    if (f === 'model') { PETM.key = e.target.value; petmPaint(); void petmLoadPrice(); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && PETM.open && PETM.phase !== 'making') { e.preventDefault(); e.stopPropagation(); petmClose(); }
  }, true);
  if (typeof BR !== 'undefined' && BR && BR.pet && BR.pet.onOpenMaker) BR.pet.onOpenMaker(() => { void petmOpen(); });
}
