/* Studio › recent prompts (ATO-809): the last prompts a Studio page sent,
   newest first, one list per page (images, video). A click under the prompt
   box puts one back. Kept in localStorage (`atag.studio.recent.<kind>`), the
   same per-viewer store the pages keep their forms in; losing it loses only
   the list. Loaded before the pages; declares only.

   The list rules (trim, dedupe, cap, order) are pure and tested in
   test/studio-recent-prompts.test.mjs. */

const STUDIO_RECENT_MAX = 12;
const STUDIO_RECENT_PROMPT_MAX = 8000;   // CONTRACT.md: prompt ≤8000

/** The same prompt twice, whatever its case and spacing. */
function studioRecentKey(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim().toLowerCase();
}

/** A stored value as a clean list: strings only, non-empty, each once, at most `max`. */
function studioRecentParse(raw, max) {
  const cap = max || STUDIO_RECENT_MAX;
  let v = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { return []; } }
  if (!Array.isArray(v)) return [];
  const out = [], seen = new Set();
  for (const x of v) {
    if (typeof x !== 'string') continue;
    const t = x.trim().slice(0, STUDIO_RECENT_PROMPT_MAX);
    const k = studioRecentKey(t);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= cap) break;
  }
  return out;
}

/** `list` with `prompt` on top: an earlier copy of it moves up, the oldest past `max` drops off. A blank prompt changes nothing. */
function studioRecentAdd(list, prompt, max) {
  const cap = max || STUDIO_RECENT_MAX;
  const cur = studioRecentParse(list, cap);
  const t = String(prompt == null ? '' : prompt).trim().slice(0, STUDIO_RECENT_PROMPT_MAX);
  const k = studioRecentKey(t);
  if (!k) return cur;
  return [t].concat(cur.filter((x) => studioRecentKey(x) !== k)).slice(0, cap);
}

/** One line for the list: spacing flattened, cut at `max` characters with an ellipsis. */
function studioRecentLabel(text, max) {
  const n = max || 90;
  const flat = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return flat.length > n ? flat.slice(0, n - 1).trimEnd() + '…' : flat;
}

/**
 * The Recent chip under a prompt box and, when `open`, the list under it.
 * `attr(verb, arg)` gives a button's click attribute in the page's own scheme
 * (verbs `recent` to toggle, `recent-use` with the index); nothing when the
 * list is empty.
 */
function studioRecentHTML(list, open, attr) {
  const items = Array.isArray(list) ? list : [];
  if (!items.length) return '';
  const e = (x) => String(x).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const icon = typeof ic === 'function' ? ic('clock') : '';
  return '<div class="st-recent">'
    + '<button class="st-recent-chip' + (open ? ' on' : '') + '" ' + attr('recent', '') + ' aria-expanded="' + (open ? 'true' : 'false') + '">' + icon + '<span>Recent</span></button>'
    + (open ? '<div class="st-recent-list" role="list">'
      + items.map((t, i) => '<button class="st-recent-item" role="listitem" ' + attr('recent-use', String(i)) + ' title="' + e(t) + '">' + e(studioRecentLabel(t)) + '</button>').join('')
      + '</div>' : '')
    + '</div>';
}

function studioRecentStoreKey(kind) { return 'atag.studio.recent.' + (kind === 'video' ? 'video' : 'image'); }

/** The page's list from storage ([] in a private window or on a bad value). */
function studioRecentLoad(kind) {
  try {
    const s = typeof localStorage !== 'undefined' ? localStorage : null;
    return s ? studioRecentParse(s.getItem(studioRecentStoreKey(kind))) : [];
  } catch (e) { return []; }
}

/** Put `prompt` on top of the page's list (`list`, the one it holds) and store it; returns the new list. */
function studioRecentRemember(kind, list, prompt) {
  const next = studioRecentAdd(list, prompt);
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(studioRecentStoreKey(kind), JSON.stringify(next)); } catch (e) { /* no storage: the page still holds it for this launch */ }
  return next;
}

if (typeof module !== 'undefined') {
  module.exports = {STUDIO_RECENT_MAX, studioRecentKey, studioRecentParse, studioRecentAdd, studioRecentLabel, studioRecentHTML, studioRecentStoreKey,
    studioRecentLoad, studioRecentRemember};
}
