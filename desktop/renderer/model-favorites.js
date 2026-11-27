/* ---------------- ATO-2169: favourite models at the top of the model picker ----------------
   Loaded before renderer.js. A star on a model row in the composer's model
   picker marks it a favourite; the favourites are drawn again in their own
   "Favorites" group at the top of the grouped list (selGroupedRows), above the
   current route's group, so a model used often is one click away whatever
   route is on. Clicking the star again takes it out. The row in its own group
   stays where it was, with a lit star.

   Precedent: LM Studio and Cursor pin favourite models above the full list;
   OpenRouter keeps a favourites list in its model picker.

   A favourite is "<provider>|<model id>" (local models under local-llama),
   so the same model id under two providers is two favourites.

   ATO-2500: one list with the terminal. The list lives in the agent's state
   dir, `model-favorites.json`, the file the terminal's `/model favorite` and
   ctrl+p use; main reads and writes it (main/model-favorites-ipc.ts) and
   spells a key `provider/model` there. The list ATO-2169 kept per window in
   localStorage is moved into that file once (modelFavSync) and then dropped.
   Without the bridge (the unit tests, an old preload) the list stays in
   localStorage as before. The picker reads the file again each time it
   opens, and Cmd+P before each step (model-favorites-keys.js), so a star
   set in the terminal shows and counts. A star click sends main the state
   it asks for, not a flip (modelFavToggle). With no star set the picker
   is exactly as before.

   The pure part is exported for test/model-favorites.test.mjs. */

const MODEL_FAV_KEY = 'atag.modelFavorites';
const MODEL_FAV_GROUP = 'favorites';
/* At most this many: a favourites group longer than a screen is the full list again. */
const MODEL_FAV_MAX = 20;

/** The stored list, cleaned: strings with a provider and a model, no repeats. */
function modelFavClean(raw) {
  const out = [];
  for (const k of Array.isArray(raw) ? raw : []) {
    if (typeof k !== 'string') continue;
    const at = k.indexOf('|');
    if (at <= 0 || at === k.length - 1 || out.indexOf(k) >= 0) continue;
    out.push(k);
    if (out.length >= MODEL_FAV_MAX) break;
  }
  return out;
}

/* The window's own list (ATO-2169), drawn until the shared file answers and moved into it once. */
function modelFavLegacy() {
  try { return typeof localStorage === 'undefined' ? [] : modelFavClean(JSON.parse(localStorage.getItem(MODEL_FAV_KEY) || '[]')); } catch (e) { return []; }
}
/* `shared`: the list is the terminal's file now, so nothing goes to localStorage. */
const MODEL_FAV = {keys: modelFavLegacy(), shared: false};

/* The preload's favourites routes, or null (unit tests, an old preload). */
function modelFavBridge() {
  const br = typeof window !== 'undefined' ? window.atomic : null;
  return br && typeof br.modelFavLoad === 'function' && typeof br.modelFavSet === 'function' ? br : null;
}

function modelFavSave() {
  if (MODEL_FAV.shared) return;
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(MODEL_FAV_KEY, JSON.stringify(MODEL_FAV.keys)); } catch (e) { /* no storage: the stars last this launch */ }
}

function modelFavSame(a, b) { return a.length === b.length && a.every((k, i) => k === b[i]); }

/**
 * ATO-2500: read the shared file and take its list. The first call hands
 * main the old localStorage list to merge in; once main has written it,
 * the old key is removed so it is never merged twice. `after(changed)`
 * runs once the answer is in. Without the bridge nothing happens.
 */
function modelFavSync(after) {
  const br = modelFavBridge();
  if (!br) return Promise.resolve(false);
  const legacy = MODEL_FAV.shared ? [] : modelFavLegacy();
  return Promise.resolve(br.modelFavLoad(legacy)).then((res) => {
    if (!res || !res.ok || !Array.isArray(res.keys)) return false;
    if (res.saved !== false) {
      MODEL_FAV.shared = true;
      try { if (legacy.length && typeof localStorage !== 'undefined') localStorage.removeItem(MODEL_FAV_KEY); } catch (e) { /* kept: merged again next time, no repeats */ }
    }
    const next = modelFavClean(res.keys);
    const changed = !modelFavSame(next, MODEL_FAV.keys);
    MODEL_FAV.keys = next;
    if (typeof after === 'function') after(changed);
    return changed;
  }).catch(() => false);
}

/** The favourite key a picker row stands for, or '' when the row cannot be one. */
function modelFavKey(r) {
  if (!r || !r.id) return '';
  if (r.type === 'cloudModel') return r.provider ? r.provider + '|' + r.id : '';
  // A local model only once it is on this computer: a star on a download is a promise the list cannot keep.
  if (r.type === 'localModel') return r.downloaded || r.active ? 'local-llama|' + r.id : '';
  return '';
}

function modelFavIs(key) { return !!key && MODEL_FAV.keys.indexOf(key) >= 0; }

/**
 * Star or unstar `key`; true when it is a favourite afterwards. Drawn at
 * once; with the bridge, main then sets the same state in the shared file
 * (read again first). It is sent as starred or not, never as a flip: main
 * flipping the file's copy would undo a star the terminal set on this key
 * while the picker was open. Main's list replaces this one and `after()`
 * repaints.
 */
function modelFavToggle(key, after) {
  if (!modelFavClean([key]).length) return false;
  const at = MODEL_FAV.keys.indexOf(key);
  if (at >= 0) MODEL_FAV.keys.splice(at, 1);
  else {
    if (MODEL_FAV.keys.length >= MODEL_FAV_MAX) MODEL_FAV.keys.shift();
    MODEL_FAV.keys.push(key);
  }
  const br = modelFavBridge();
  if (br && MODEL_FAV.shared) {
    Promise.resolve(br.modelFavSet(key, at < 0)).then((res) => {
      if (!res || !Array.isArray(res.keys)) return;
      MODEL_FAV.keys = modelFavClean(res.keys);
      if (typeof after === 'function') after();
    }).catch(() => { /* the star drawn stays until the next sync */ });
  } else modelFavSave();
  return at < 0;
}

/**
 * The grouped list with the Favorites group put first. `groups` and `rows` are
 * what selGroupedRows built (each row carries its `group`); the rows that are
 * favourites are copied, in the order they were starred, into a group of
 * their own. A favourite the list does not hold now (a provider whose key
 * went, a search that hides it) is not drawn. Neither input is changed.
 */
function modelFavPin(groups, rows) {
  const list = Array.isArray(rows) ? rows : [];
  const all = Array.isArray(groups) ? groups : [];
  const byKey = new Map();
  for (const r of list) {
    const k = modelFavKey(r);
    if (k && modelFavIs(k) && !byKey.has(k)) byKey.set(k, r);
  }
  /* ATO-2500: a copy says whose model it is ("OpenAI · 200K context"), as
     the row in its own group sits under that heading and the copy does not. */
  const titleOf = new Map(all.map((g) => [g.id, g.title]));
  const pinned = MODEL_FAV.keys.filter((k) => byKey.has(k))
    .map((k) => {
      const r = byKey.get(k);
      const from = titleOf.get(r.group) || r.provider || '';
      return Object.assign({}, r, {group: MODEL_FAV_GROUP, favCopy: true, favFrom: from,
        detail: [from, r.detail || ''].filter(Boolean).join(' \u00b7 ')});
    });
  if (!pinned.length) return {groups: all, rows: list};
  return {
    groups: [{id: MODEL_FAV_GROUP, title: 'Favorites', busy: false, err: null, fav: true}].concat(all),
    rows: pinned.concat(list),
  };
}

/** The star in a row's right slot. deps: {esc, ic}. '' for a row that cannot be a favourite. */
function modelFavStarHTML(r, deps) {
  const key = modelFavKey(r);
  if (!key) return '';
  const {esc, ic} = deps;
  const on = modelFavIs(key);
  const tip = on ? 'Remove from favorites' : 'Add to favorites';
  /* A span, not a button: it sits inside the row's <button>, and the click
     delegate takes its data-act before the row's (as the vision chip does). */
  return '<span role="button" tabindex="-1" class="selfav' + (on ? ' on' : '') + '" data-act="sel:fav:' + esc(key) + '"'
    + ' title="' + tip + '" aria-label="' + tip + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + ic('star') + '</span>';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {MODEL_FAV_KEY, MODEL_FAV_GROUP, MODEL_FAV_MAX, MODEL_FAV, modelFavClean, modelFavKey, modelFavIs, modelFavToggle, modelFavPin, modelFavStarHTML, modelFavSync, modelFavBridge};
}

/* ATO-2500: take the shared list as soon as the window is up (the stars
   show only in the picker, which opens later and syncs again). */
if (typeof window !== 'undefined' && modelFavBridge()) modelFavSync();
