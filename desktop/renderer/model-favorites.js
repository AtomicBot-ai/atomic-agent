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
   so the same model id under two providers is two favourites. The list is
   kept per viewer in localStorage, like the side panel's order switch
   (insp-order.js): a display preference, nothing the agent reads. With no
   star set the picker is exactly as before.

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

const MODEL_FAV = {keys: (() => {
  try { return typeof localStorage === 'undefined' ? [] : modelFavClean(JSON.parse(localStorage.getItem(MODEL_FAV_KEY) || '[]')); } catch (e) { return []; }
})()};

function modelFavSave() {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(MODEL_FAV_KEY, JSON.stringify(MODEL_FAV.keys)); } catch (e) { /* no storage: the stars last this launch */ }
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

/** Star or unstar `key`; true when it is a favourite afterwards. */
function modelFavToggle(key) {
  if (!modelFavClean([key]).length) return false;
  const at = MODEL_FAV.keys.indexOf(key);
  if (at >= 0) MODEL_FAV.keys.splice(at, 1);
  else {
    if (MODEL_FAV.keys.length >= MODEL_FAV_MAX) MODEL_FAV.keys.shift();
    MODEL_FAV.keys.push(key);
  }
  modelFavSave();
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
  const pinned = MODEL_FAV.keys.filter((k) => byKey.has(k))
    .map((k) => Object.assign({}, byKey.get(k), {group: MODEL_FAV_GROUP, favCopy: true}));
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
  module.exports = {MODEL_FAV_KEY, MODEL_FAV_GROUP, MODEL_FAV_MAX, MODEL_FAV, modelFavClean, modelFavKey, modelFavIs, modelFavToggle, modelFavPin, modelFavStarHTML};
}
