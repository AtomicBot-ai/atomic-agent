/* ---------------- ATO-41: Settings › Diagnostics' All settings ----------------
   Loaded before renderer.js; declares only. Shared by the renderer and the
   Node checks (test/all-settings.test.mjs).

   Every config.json key with its current value, default, type and
   description, read from the agent (`atag config list --json`, through
   main/settings-reference.ts), with a search box. A plain value (true/false,
   a number, a word) can be changed here; it is written the way the app's
   other settings are: PATCH /api/config, live, or `atag config set` on an
   older agent, which then needs a restart. Keys that belong to a panel of
   their own (models, Telegram, analytics…) are shown but not edited here,
   because those panels do more than write the value. */

const ALLSET = {open: false, rows: null, legacy: false, note: '', err: '', busy: false, q: '', editKey: null, draft: '', msg: '', restartHint: false, onChange: null};

/* Shown, not edited: a panel owns them, or the app keeps them for itself. */
const ALLSET_OWNED = ['version', 'localModels.', 'analytics.', 'telegram.', 'discord.', 'swarm.', 'composio.', 'atomicMail.', 'git.', 'tui.onboarding.', 'tui.sessionRail.'];
/* Rows drawn at once; a search narrows the rest. */
const ALLSET_LIMIT = 80;

/* The agent's own rule (config-paths.ts isSecretConfigKey): never offer to edit a credential. */
function allSetIsSecret(key) {
  const last = key.slice(key.lastIndexOf('.') + 1);
  const words = last.split(/(?=[A-Z])/).map((w) => w.toLowerCase());
  const names = new Set(['secret', 'token', 'apikey', 'password']);
  return words.some((w, i) => names.has(w) || names.has(w + (words[i + 1] || '')));
}

function allSetOwned(key) {
  return ALLSET_OWNED.some((p) => (p.endsWith('.') ? key.startsWith(p) : key === p));
}

/* What the edit control is: 'bool', 'text', or '' when the row is read-only here. */
function allSetEditKind(row) {
  if (!row || !row.settable || allSetOwned(row.key) || allSetIsSecret(row.key)) return '';
  if (/\[\]|\{/.test(row.type || '')) return '';
  const d = row.default;
  if (typeof d === 'boolean' && /^boolean( \| null)?$/.test(row.type || 'boolean')) return 'bool';
  if (d === null || ['number', 'string', 'boolean'].includes(typeof d)) return 'text';
  return '';
}

function allSetFormat(v) {
  return v === undefined ? 'unset' : JSON.stringify(v);
}

/* Rows whose key, description or env variable holds every word of the search. */
function allSetFilter(rows, q) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return rows.slice();
  return rows.filter((r) => {
    const hay = (r.key + ' ' + (r.description || '') + ' ' + (r.envVar || '')).toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/* The typed value for a draft, or an error in plain words. */
function allSetCoerce(row, raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return {ok: false, error: 'Type a value, or use Reset to go back to the default.'};
  const type = row.type || typeof row.default;
  if (allSetEditKind(row) === 'bool' || (typeof row.default === 'boolean' && /^(true|false)$/.test(text))) {
    if (!/^(true|false)$/.test(text)) return {ok: false, error: 'This one is true or false.'};
    return {ok: true, value: text === 'true'};
  }
  const numeric = /^-?\d+(\.\d+)?$/.test(text);
  if (/\bnumber\b/.test(type) && numeric) return {ok: true, value: Number(text)};
  if (type === 'number') return {ok: false, error: 'This one is a number.'};
  return {ok: true, value: text};
}

/* {a:{b:{c:value}}} for `a.b.c`: the deep-merge patch PATCH /api/config takes. */
function allSetPatch(key, value) {
  const parts = key.split('.');
  const root = {};
  let node = root;
  parts.forEach((p, i) => { if (i === parts.length - 1) node[p] = value; else node = node[p] = {}; });
  return root;
}

function allSetRowHTML(r, st, esc) {
  const changed = allSetFormat(r.value) !== allSetFormat(r.default);
  const kind = allSetEditKind(r);
  const editing = st.editKey === r.key;
  let control = '';
  if (editing) {
    const field = kind === 'bool'
      ? '<select id="allset-edit" class="allset-edit">' + ['true', 'false'].map((o) => '<option' + (st.draft === o ? ' selected' : '') + '>' + o + '</option>').join('') + '</select>'
      : '<input id="allset-edit" class="allset-edit mono" value="' + esc(st.draft) + '" spellcheck="false" autocomplete="off">';
    control = '<div class="allset-editrow">' + field
      + '<button class="btn btn-p xs" data-act="allset:save"' + (st.busy ? ' disabled' : '') + '>Save</button>'
      + '<button class="btn btn-s xs" data-act="allset:cancel">Cancel</button>'
      + (changed ? '<button class="btn btn-s xs" data-act="allset:reset:' + esc(r.key) + '"' + (st.busy ? ' disabled' : '') + '>Reset to default</button>' : '')
      + '</div>';
  } else if (kind) {
    control = '<button class="btn btn-s xs allset-editbtn" data-act="allset:edit:' + esc(r.key) + '">Edit</button>';
  }
  return '<div class="tk-setrow allset-row' + (changed ? ' is-changed' : '') + '">'
    + '<div class="t mono">' + esc(r.key) + (r.type ? ' <span class="allset-type">' + esc(r.type) + '</span>' : '') + '</div>'
    + '<div class="set-diagv">'
      + '<div class="mono">' + esc(allSetFormat(r.value)) + (changed ? ' <span class="set-cap">default ' + esc(allSetFormat(r.default)) + '</span>' : '') + '</div>'
      + (r.description ? '<div class="set-cap">' + esc(r.description) + '</div>' : '')
      + (r.envVar ? '<div class="set-cap">The environment variable ' + esc(r.envVar) + ' wins over this when it is set.</div>' : '')
      + control
    + '</div></div>';
}

/* The list part only, so a keystroke in the search box repaints it without touching the box. */
function allSetListHTML(st, esc) {
  if (!st.rows) return '';
  const hits = allSetFilter(st.rows, st.q);
  if (!hits.length) return '<p class="set-cap">No setting matches “' + esc(st.q) + '”.</p>';
  const shown = hits.slice(0, ALLSET_LIMIT);
  return '<div class="tk-list set-setlist allset-list">' + shown.map((r) => allSetRowHTML(r, st, esc)).join('') + '</div>'
    + (hits.length > shown.length ? '<p class="set-cap">' + (hits.length - shown.length) + ' more. Add a word to the search to narrow it.</p>' : '');
}

function allSettingsHTML(st, h) {
  const esc = h.esc;
  const head = '<h4 class="set-h">All settings</h4>'
    + '<p class="set-desc">Every setting in config.json with its value, default and what it does, the same list as <span class="mono">atag config list --describe</span>. Settings that only exist as environment variables are listed by <span class="mono">atag config env</span>.</p>';
  if (!st.open) {
    return head + '<div class="set-diagacts"><button class="btn btn-s sm" data-act="allset:open"' + (st.busy ? ' disabled' : '') + '>' + (st.busy ? 'Loading…' : 'Show all settings') + '</button></div>'
      + (st.err ? '<p class="set-cap set-err">' + esc(st.err) + '</p>' : '');
  }
  const count = st.rows ? st.rows.length + ' settings' : '';
  return head
    + '<div class="set-diagacts">'
      + '<label class="tk-inpwrap set-search is-open">' + h.ic('search') + '<input id="allset-q" value="' + esc(st.q) + '" placeholder="Search settings" autocomplete="off" spellcheck="false"></label>'
      + '<span class="set-cap">' + esc(count) + '</span>'
      + '<button class="btn btn-s sm" data-act="allset:close">Hide</button>'
    + '</div>'
    + (st.note ? '<p class="set-cap">' + esc(st.note) + '</p>' : '')
    + (st.msg ? '<p class="set-cap">' + esc(st.msg) + (st.restartHint ? ' <button class="btn btn-s xs" data-act="agent:restart">Restart agent</button>' : '') + '</p>' : '')
    + (st.err ? '<p class="set-cap set-err">' + esc(st.err) + '</p>' : '')
    + '<div id="allset-list">' + allSetListHTML(st, esc) + '</div>';
}

/* The search box and the edit field keep their text in ALLSET across repaints. */
function allSettingsInput(e, esc) {
  const t = e && e.target;
  if (!t || (t.id !== 'allset-q' && t.id !== 'allset-edit')) return false;
  if (t.id === 'allset-edit') { ALLSET.draft = t.value; return true; }
  ALLSET.q = t.value;
  const box = typeof document !== 'undefined' && document.getElementById('allset-list');
  if (box) box.innerHTML = allSetListHTML(ALLSET, esc);
  return true;
}

/* Verbs: open, close, edit:<key>, cancel, save, reset:<key>.
   deps: {write(key, value, patch) → {ok, live, error}, unset(key) → {ok, error}}. */
async function allSettingsAct(v, br, deps) {
  const st = ALLSET;
  const paint = () => { if (st.onChange) st.onChange(); };
  const load = async () => {
    const r = await br.settingsReference();
    if (r && r.ok) { st.rows = r.rows || []; st.legacy = !!r.legacy; st.note = r.note || ''; st.err = ''; }
    else st.err = (r && r.error) || 'The settings did not load.';
    return !!(r && r.ok);
  };
  const verb = String(v || '');
  if (verb === 'close') { st.open = false; st.editKey = null; st.msg = ''; paint(); return; }
  if (verb === 'cancel') { st.editKey = null; paint(); return; }
  if (verb.startsWith('edit:')) {
    const row = (st.rows || []).find((r) => r.key === verb.slice(5));
    if (!row || !allSetEditKind(row)) return;
    st.editKey = row.key;
    st.draft = typeof row.value === 'string' ? row.value : row.value === null || row.value === undefined ? '' : String(row.value);
    st.err = ''; st.msg = '';
    paint();
    return;
  }
  if (!br || !br.settingsReference || st.busy) return;
  st.busy = true; st.err = ''; paint();
  try {
    if (verb === 'open') {
      if (await load()) st.open = true;
    } else if (verb === 'save' || verb.startsWith('reset:')) {
      const key = verb === 'save' ? st.editKey : verb.slice(6);
      const row = (st.rows || []).find((r) => r.key === key);
      if (!row || !allSetEditKind(row)) return;
      let res;
      if (verb === 'save') {
        const c = allSetCoerce(row, st.draft);
        if (!c.ok) { st.err = c.error; return; }
        res = await deps.write(key, c.value, allSetPatch(key, c.value));
      } else {
        res = await deps.unset(key);
        if (res && res.ok) res = {ok: true, live: false};
      }
      if (!res || !res.ok) { st.err = (res && res.error) || 'It was not saved.'; return; }
      st.editKey = null;
      st.restartHint = !res.live;
      st.msg = res.live ? 'Saved. The agent uses it from the next message.' : 'Saved to config.json. The agent reads it after a restart.';
      await load();
    }
  } catch (e) {
    st.err = String((e && e.message) || e);
  } finally {
    st.busy = false;
    paint();
  }
}

if (typeof module !== 'undefined') module.exports = {ALLSET, ALLSET_OWNED, allSetIsSecret, allSetEditKind, allSetFilter, allSetCoerce, allSetPatch, allSetListHTML, allSettingsHTML, allSettingsInput, allSettingsAct};
