/* ---------------- ATO-1072: Save as recipe, and the Recipes gallery ----------------
   Loaded before renderer.js; declares only. The pure half is shared with the
   Node checks (test/chat-recipe-ui.test.mjs); the renderer half reads
   renderer.js globals at call time, as handoff.js does.

   Recipe v1 (ATO-1615): title, optional description, task text with {{key}}
   placeholders, up to 16 parameters with optional defaults; never a model,
   tools, MCP servers, skills or permissions. "Save as recipe…" (a stored
   chat's row menu) fills a sheet from the chat's FIRST question, read from
   the stored chat as openSession reads it; selecting words and pressing
   "Make a parameter" turns them into {{key}} with the words as the default.
   main/recipes-store.ts checks a recipe as the atomicagent://recipe link
   route does, so every saved one can be shared. The gallery (sidebar row,
   palette): Run asks for the parameters and opens a New chat with the filled
   text in the box, never sent; Copy link, Edit, Delete. */

/** `{{ key }}`, as main/recipes-store.ts RECIPE_PLACEHOLDER_RE. */
const RECIPE_PLACEHOLDER_RE = /\{\{\s*([^{}\s]*)\s*\}\}/g;
const RECIPE_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
const RECIPE_MAX_PARAMS = 16;

/** The placeholders the text uses, each once, in order. */
function recipePlaceholders(prompt) {
  const out = [];
  for (const m of String(prompt || '').matchAll(RECIPE_PLACEHOLDER_RE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** The text with each `{{key}}` replaced by its value; a value is text only. */
function recipeFill(prompt, values) {
  const v = values && typeof values === 'object' ? values : {};
  return String(prompt || '').replace(RECIPE_PLACEHOLDER_RE, (whole, key) => (Object.prototype.hasOwnProperty.call(v, key) ? String(v[key]) : whole));
}

/** The parameters still empty, by key. */
function recipeMissing(params, values) {
  const v = values && typeof values === 'object' ? values : {};
  return (params || []).filter((p) => !String(v[p.key] == null ? '' : v[p.key]).trim()).map((p) => p.key);
}

/** A parameter name for the selected words: lowercase, `_` between words, not one already taken. */
function recipeKeyFrom(text, taken) {
  let key = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!key) key = 'param';
  if (!/^[a-z]/.test(key)) key = 'p_' + key;
  key = key.slice(0, 28).replace(/_+$/, '');
  const used = taken || [];
  let out = key, n = 2;
  while (used.includes(out)) out = key + '_' + (n++);
  return out;
}

/** The chat's first question, from the stored turns (GET /api/sessions/{id}). A message sent
    with files ends in an `[attachments]` block of local paths (attachments.js): cut, never shared. */
function recipeFirstQuestion(turns) {
  for (const x of Array.isArray(turns) ? turns : []) {
    if (!x || x.kind !== 'user' || typeof x.text !== 'string') continue;
    const at = x.text.indexOf('\n\n[attachments]\n');
    const text = (at >= 0 ? x.text.slice(0, at) : x.text).trim();
    if (text) return text;
  }
  return '';
}

/** The parameters the save sends: the text's placeholders, in order, with the defaults typed for them. */
function recipeParamsFor(prompt, defaults) {
  const d = defaults || {};
  return recipePlaceholders(prompt).map((key) => (d[key] ? {key, default: String(d[key])} : {key}));
}

/** A saved recipe's defaults, by key ('' for none). */
function recipeDefaults(r) {
  const out = {};
  for (const p of (r && r.params) || []) out[p.key] = p.default || '';
  return out;
}

/* ---- renderer side (globals from renderer.js, read at call time) ---- */

const RECIPES = {list: null, loading: false, error: null, edit: null, run: null, seq: 0};

const recipeById = (id) => (RECIPES.list || []).find((r) => r.id === id) || null;

async function recipeLoad() {
  if (!BR || !BR.recipesList) { RECIPES.error = 'This build cannot keep recipes.'; render(); return; }
  const seq = ++RECIPES.seq;
  RECIPES.loading = true; RECIPES.error = null; render();
  const res = await BR.recipesList();
  if (seq !== RECIPES.seq) return;
  RECIPES.loading = false;
  if (!res || !res.ok) RECIPES.error = (res && res.error) || 'Could not read the recipes.';
  else RECIPES.list = res.recipes || [];
  render();
}

const recipeErrorHTML = (msg) => (msg ? '<div class="tk-notice tk-notice--red">' + ic('alert') + '<span class="grow">' + esc(msg) + '</span></div>' : '');

function recipeParamsHTML(e) {
  const keys = recipePlaceholders(e.prompt);
  if (!keys.length) return '<p class="sd-cap">No parameters yet. Select a word in the text and press Make a parameter, or type {{name}} yourself.</p>';
  return keys.map((key) => '<label class="sd-cap" style="display:block;margin-top:6px">Default for <span class="sd-mono">{{' + esc(key) + '}}</span>'
    + '<input class="tk-inp" type="text" id="recipe-def-' + esc(key) + '" data-recipe-default="' + esc(key) + '" value="' + esc(e.defaults[key] || '') + '"'
    + ' placeholder="optional" spellcheck="false" style="display:block;width:100%"' + (e.saving ? ' disabled' : '') + '></label>').join('');
}

function recipeEditHTML() {
  const e = RECIPES.edit;
  if (!e) return '';
  let body;
  if (e.loading) body = '<div class="tk-empty"><span class="tk-spin"></span><p>Reading the chat…</p></div>';
  else {
    const dis = e.saving ? ' disabled' : '';
    body = '<p class="sd-cap">A recipe keeps the task text only. The model, tools and permissions stay as each chat has them.</p>'
      + '<label class="sd-cap" for="recipe-title">Title</label>'
      + '<input id="recipe-title" class="tk-inp" maxlength="120" value="' + esc(e.title) + '"' + dis + '>'
      + '<label class="sd-cap" for="recipe-desc">Description (optional)</label>'
      + '<input id="recipe-desc" class="tk-inp" maxlength="300" value="' + esc(e.description) + '"' + dis + '>'
      + '<label class="sd-cap" for="recipe-prompt">Task text</label>'
      + '<textarea id="recipe-prompt" class="tk-inp sd-json" rows="9" maxlength="6000"' + dis + '>' + esc(e.prompt) + '</textarea>'
      + '<div style="display:flex;justify-content:flex-end;margin-top:4px"><button class="btn btn-g sm" data-act="recipe:param"' + dis + '>' + ic('wand') + 'Make a parameter</button></div>'
      + '<div id="recipe-params">' + recipeParamsHTML(e) + '</div>';
  }
  body += recipeErrorHTML(e.error);
  return sheet(e.id ? 'Edit recipe' : 'Save as recipe', body,
    '<span class="grow"></span><button class="btn btn-s sm" data-act="close">Cancel</button>'
    + '<button class="btn btn-p sm" data-act="recipe:save"' + (e.saving || e.loading ? ' disabled' : '') + '>' + (e.saving ? '<span class="tk-spin"></span>' : '') + 'Save</button>',
    'sheet-recipe');
}

function recipeRunHTML(r) {
  const run = RECIPES.run;
  let body = '<p class="sd-cap">The filled text goes in a new chat’s box. Nothing is sent until you press Enter there.</p>'
    + '<div class="sd-mono" style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:30vh;overflow:auto">' + esc(r.prompt) + '</div>';
  for (const p of r.params || []) {
    body += '<label class="sd-cap" style="display:block;margin-top:8px">' + esc(p.key.replace(/_/g, ' ')) + ' <span class="sd-mono">{{' + esc(p.key) + '}}</span>'
      + '<input class="tk-inp" type="text" id="recipe-val-' + esc(p.key) + '" data-recipe-value="' + esc(p.key) + '" value="' + esc(run.values[p.key] || '') + '" spellcheck="false" style="display:block;width:100%"></label>';
  }
  const ready = recipeMissing(r.params, run.values).length === 0;
  return sheet(r.title, body,
    '<button class="btn btn-g sm" data-act="recipe:runback">' + ic('chevL') + 'All recipes</button><span class="grow"></span>'
    + '<button class="btn btn-p sm" data-act="recipe:go"' + (ready ? '' : ' disabled') + '>Open in new chat</button>',
    'sheet-recipe');
}

function recipeGalleryHTML() {
  const run = RECIPES.run && recipeById(RECIPES.run.id);
  if (run) return recipeRunHTML(run);
  let body = '';
  body += recipeErrorHTML(RECIPES.error);
  if (RECIPES.loading && !RECIPES.list) body += '<div class="tk-empty"><span class="tk-spin"></span><p>Reading recipes…</p></div>';
  else if (RECIPES.list) {
    const rows = RECIPES.list.map((r) => {
      const n = (r.params || []).length;
      const meta = [r.description || '', n ? n + (n === 1 ? ' parameter' : ' parameters') : ''].filter(Boolean).join(' · ');
      return '<div class="row reciperow"><span class="main"><span class="t">' + esc(r.title) + '</span>'
        + (meta ? '<span class="s">' + esc(meta) + '</span>' : '') + '</span>'
        + '<button class="btn btn-p sm" data-act="recipe:run:' + esc(r.id) + '">Run</button>'
        + '<button class="btn btn-g sm" data-act="recipe:copy:' + esc(r.id) + '" title="Copy link">' + ic('link') + '</button>'
        + '<button class="btn btn-g sm" data-act="recipe:edit:' + esc(r.id) + '" title="Edit">' + ic('edit') + '</button>'
        + '<button class="btn btn-g sm" data-act="recipe:delask:' + esc(r.id) + '" title="Delete">' + ic('trash') + '</button></div>';
    }).join('');
    body += '<div class="rows reciperows">' + (rows || '<div class="sesempty">No recipes yet. Open a chat’s menu (…) and pick Save as recipe….</div>') + '</div>';
  }
  return sheet('Recipes', body, '<span class="grow"></span><button class="btn btn-s sm" data-act="close">Close</button>', 'sheet-recipe');
}

/** renderer.js overlaysHTML: the sheet on screen, if it is one of these. */
function recipeSheetHTML() {
  if (S.overlay === 'recipe-edit') return recipeEditHTML();
  if (S.overlay === 'recipes') return recipeGalleryHTML();
  return '';
}

async function recipeFromChat(sid) {
  const row = typeof chatById === 'function' ? chatById(sid) : null;
  const seq = ++RECIPES.seq;
  RECIPES.edit = {id: null, title: (row && row.t) || '', description: '', prompt: '', defaults: {}, loading: true, saving: false, error: null};
  S.overlay = 'recipe-edit';
  render();
  const res = BR && BR.session ? await BR.session(sid) : null;
  if (seq !== RECIPES.seq || !RECIPES.edit) return;
  const e = RECIPES.edit; e.loading = false;
  if (!res || !res.ok || !res.data) e.error = (res && res.error) || 'Could not read this chat.';
  else {
    e.prompt = recipeFirstQuestion(res.data.turns);
    if (!e.prompt) e.error = 'This chat has no question to save yet.';
  }
  render();
}

function recipeEditOpen(id) {
  const r = recipeById(id);
  if (!r) return;
  RECIPES.edit = {id: r.id, title: r.title, description: r.description || '', prompt: r.prompt, defaults: recipeDefaults(r), loading: false, saving: false, error: null};
  S.overlay = 'recipe-edit';
  render();
}

/** "Make a parameter": the selected words become {{key}}, and their text its default. */
function recipeMakeParam() {
  const e = RECIPES.edit, box = typeof document !== 'undefined' ? document.getElementById('recipe-prompt') : null;
  if (!e || !box) return;   // the box holds the text as typed: e.prompt follows it on every input
  e.prompt = box.value;
  const a = box.selectionStart, b = box.selectionEnd;
  const word = e.prompt.slice(a, b).trim();
  if (!word) { toast('Select a word first', 'Select the words in the text that change each time, then press Make a parameter.'); return; }
  const keys = recipePlaceholders(e.prompt);
  if (keys.length >= RECIPE_MAX_PARAMS) { toast('No more parameters', 'A recipe has at most ' + RECIPE_MAX_PARAMS + '.', 'bad'); return; }
  const key = recipeKeyFrom(word, keys);
  e.prompt = e.prompt.slice(0, a) + '{{' + key + '}}' + e.prompt.slice(b);
  if (word.length <= 500 && !/[\r\n\t]/.test(word)) e.defaults[key] = word;
  e.error = null;
  render();
}

async function recipeSave() {
  const e = RECIPES.edit;
  if (!e || e.saving || e.loading) return;
  if (!BR || !BR.recipesSave) { e.error = 'This build cannot keep recipes.'; render(); return; }
  const bad = recipePlaceholders(e.prompt).find((k) => !RECIPE_KEY_RE.test(k));
  if (bad !== undefined) { e.error = 'The text has {{' + bad + '}}: a parameter name can use lowercase letters, digits and _ (up to 32), starting with a letter.'; render(); return; }
  e.saving = true; e.error = null;
  render();
  const res = await BR.recipesSave({...(e.id ? {id: e.id} : {}), title: e.title, description: e.description, prompt: e.prompt, params: recipeParamsFor(e.prompt, e.defaults)});
  if (RECIPES.edit !== e) return;
  e.saving = false;
  if (!res || !res.ok) { e.error = (res && res.error) || 'Could not save the recipe.'; render(); return; }
  RECIPES.list = res.recipes || RECIPES.list;
  RECIPES.edit = null; RECIPES.run = null;
  S.overlay = 'recipes';
  render();
  toast('Recipe saved', res.recipe ? res.recipe.title : '');
}

/** Run: a New chat with the filled text in its box. Never sent from here. */
function recipeGo() {
  const r = RECIPES.run && recipeById(RECIPES.run.id);
  if (!r) return;
  const values = RECIPES.run.values;
  if (recipeMissing(r.params, values).length) return;
  const text = recipeFill(r.prompt, values);
  RECIPES.run = null;
  act('session:new');   // the shared New chat: closes this sheet, leaves the chat that was open as it is
  // The draft is set once the new chat is on screen, as handoff.js does.
  S.draft = text;
  render();
  const entry = $('#entry');
  if (entry) { entry.value = text; autosize(entry); entry.focus(); }
  toast('Recipe ready', 'The task is in the box. Read it, pick the model and press Enter to send.');
}

if (typeof document !== 'undefined') {
  document.addEventListener('input', (ev) => {
    const t = ev.target, e = RECIPES.edit;
    if (!t) return;
    if (RECIPES.run && t.dataset && t.dataset.recipeValue !== undefined) {
      RECIPES.run.values[t.dataset.recipeValue] = t.value;
      const r = recipeById(RECIPES.run.id), go = document.querySelector('[data-act="recipe:go"]');
      if (r && go) go.disabled = recipeMissing(r.params, RECIPES.run.values).length > 0;
      return;
    }
    if (!e) return;
    if (t.id === 'recipe-title') e.title = t.value;
    else if (t.id === 'recipe-desc') e.description = t.value;
    else if (t.dataset && t.dataset.recipeDefault !== undefined) e.defaults[t.dataset.recipeDefault] = t.value;
    else if (t.id === 'recipe-prompt') {
      const before = recipePlaceholders(e.prompt).join(' ');
      e.prompt = t.value;
      // Only the parameters box is redrawn, so the caret stays where it is in the text.
      const box = document.getElementById('recipe-params');
      if (box && recipePlaceholders(e.prompt).join(' ') !== before) box.innerHTML = recipeParamsHTML(e);
    }
  });
}

/** `recipe:<verb>` from act(): gallery · save:<chat id> · edit:<id> · param · save · run:<id> · runback · go · copy:<id> · delask:<id> · del:<id>.
    `close` is act()'s own: the verbs that open a sheet take every other overlay down first. */
function recipeAct(v, close) {
  const colon = v.indexOf(':'), verb = colon < 0 ? v : v.slice(0, colon), arg = colon < 0 ? '' : v.slice(colon + 1);
  if (verb === 'gallery') { close(); S.settings = null; RECIPES.run = null; RECIPES.edit = null; S.overlay = 'recipes'; recipeLoad(); return; }
  if (verb === 'save' && arg) { close(); S.settings = null; recipeFromChat(arg); return; }
  if (verb === 'save') { recipeSave(); return; }
  if (verb === 'param') { recipeMakeParam(); return; }
  if (verb === 'edit') { recipeEditOpen(arg); return; }
  if (verb === 'run') { const r = recipeById(arg); if (r) { RECIPES.run = {id: r.id, values: recipeDefaults(r)}; render(); } return; }
  if (verb === 'runback') { RECIPES.run = null; render(); return; }
  if (verb === 'go') { recipeGo(); return; }
  if (verb === 'copy') { const r = recipeById(arg); if (r && r.link) copyText(r.link, 'Recipe link copied', 'Anyone with Atomic Agent can open it. It carries the text only.'); return; }
  if (verb === 'delask') {
    const r = recipeById(arg);
    if (r) { S.alert = {title: 'Delete recipe “' + r.title + '”?', msg: 'The recipe is removed from this computer. Links already shared keep working. This cannot be undone.', ok: 'Delete', act: 'recipe:del:' + r.id}; render(); }
    return;
  }
  if (verb === 'del') {
    S.alert = null;
    if (!BR || !BR.recipesDelete) { render(); return; }
    BR.recipesDelete(arg).then((res) => {
      if (!res || !res.ok) { toast('Could not delete the recipe', (res && res.error) || '', 'bad'); render(); return; }
      RECIPES.list = res.recipes || [];
      render();
      toast('Recipe deleted');
    });
  }
}

if (typeof module !== 'undefined') module.exports = {recipePlaceholders, recipeFill, recipeMissing, recipeKeyFrom, recipeFirstQuestion, recipeParamsFor, recipeDefaults};
