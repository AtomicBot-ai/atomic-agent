/* ATO-2499 "Show once": what a recorded draft adds to its preview under Settings › Skills › To review
   (workspace-skills.js draws the preview itself). The step pictures, when the recording took them
   (main/show-once-review-ipc.ts showOnce:draftSnapshots). Only for drafts whose source is a Show once
   recording. Shared by the renderer and the Node checks. */
const SHOW_ONCE_DRAFT_SOURCE = 'show-once recording'; // main/show-once-draft.ts SHOW_ONCE_SOURCE
function showOnceDraftIs(draft) {
  return !!draft && Array.isArray(draft.sources) && draft.sources.indexOf(SHOW_ONCE_DRAFT_SOURCE) >= 0;
}
function showOnceDraftPicturesHTML(v, esc) {
  if (v.loading) return '<p class="set-cap"><span class="tk-spin"></span> Loading the step pictures…</p>';
  const pics = Array.isArray(v.pictures) ? v.pictures.filter(p => p && Number.isInteger(p.step) && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(String(p.src))) : [];
  if (!pics.length) return '';
  return '<p class="set-cap">The window after each step, as recorded (kept on this Mac, deleted with the draft):</p>'
    + '<div class="show-once-pics">' + pics.map(p => '<figure class="show-once-pic"><img src="' + esc(p.src) + '" alt="The window after step '
      + p.step + '" loading="lazy"><figcaption class="set-cap">Step ' + p.step + '</figcaption></figure>').join('') + '</div>';
}
function createShowOnceDraftView(deps) {
  const v = {id: null, pictures: [], loading: false, seq: 0};
  const api = () => deps.api() || {};
  async function load(id) {
    const br = api();
    const seq = ++v.seq;
    v.id = id; v.pictures = []; v.loading = typeof br.showOnceDraftSnapshots === 'function';
    if (!v.loading) return;
    let res = null;
    try { res = await br.showOnceDraftSnapshots(id); } catch (e) { res = null; }
    if (seq !== v.seq) return;
    v.loading = false;
    v.pictures = res && res.ok && Array.isArray(res.pictures) ? res.pictures : [];
    deps.paint();
  }
  /* `open` is the drafts controller's open preview ({id, draft}); '' for anything but a loaded Show once draft. */
  function html(open, esc) {
    if (!open || !open.draft || !showOnceDraftIs(open.draft)) return '';
    if (v.id !== open.id) void load(open.id);
    return '<div class="show-once-draft">' + showOnceDraftPicturesHTML(v, esc) + '</div>';
  }
  return {view: v, html, load};
}
if (typeof module !== 'undefined') module.exports = {SHOW_ONCE_DRAFT_SOURCE, showOnceDraftIs, showOnceDraftPicturesHTML, createShowOnceDraftView};
