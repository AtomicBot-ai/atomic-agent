/* ATO-2499 "Show once": what a recorded draft adds to its preview under Settings › Skills › To review
   (workspace-skills.js draws the preview itself): "Test skill", which opens a new chat where the agent
   replays the draft once and stops at the first step whose check fails, and the step pictures, when the
   recording took them (main/show-once-review-ipc.ts showOnce:draftSnapshots). Only for drafts whose
   source is a Show once recording. Shared by the renderer and the Node checks. */
const SHOW_ONCE_DRAFT_SOURCE = 'show-once recording'; // main/show-once-draft.ts SHOW_ONCE_SOURCE
function showOnceDraftIs(draft) {
  return !!draft && Array.isArray(draft.sources) && draft.sources.indexOf(SHOW_ONCE_DRAFT_SOURCE) >= 0;
}
const SHOW_ONCE_TEST_MAX = 12000; // characters of the draft sent in the test message
/* The test chat's first message: a dry run of a draft that is not installed, so its text goes along. */
function showOnceTestMessage(name, skillMd) {
  const text = String(skillMd || '');
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
  const cut = body.length > SHOW_ONCE_TEST_MAX ? body.slice(0, SHOW_ONCE_TEST_MAX) + '\n\n(The rest of the draft was cut. Stop after the last step shown.)' : body;
  return 'Test the skill draft ' + JSON.stringify(String(name || 'show-once')) + ' once, as a dry run, before I approve it. '
    + 'It is not installed yet, so its instructions are below. Do it on this computer step by step, as its How to replay section says, '
    + 'and do the replay check after every step. Stop at the first step that does not match and tell me the step number, '
    + 'what you expected and what you saw. Ask me for any text a step needs. Change nothing else.\n\n' + cut;
}
function showOnceTestHTML(open, esc) {
  const ready = open.draft && typeof open.draft.skillMd === 'string' && open.draft.skillMd.length > 0;
  return '<div class="tk-notice set-softnote show-once-test"><span class="grow">Run this draft once in a new chat. The agent '
    + 'stops at the first step that does not look as recorded and says which one. It asks before it controls an app.</span>'
    + '<button class="btn btn-s sm" data-act="skills:showOnceDraft:test"' + (ready ? '' : ' disabled') + '>Test skill</button></div>';
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
    return '<div class="show-once-draft">' + showOnceTestHTML(open, esc) + showOnceDraftPicturesHTML(v, esc) + '</div>';
  }
  /* `test`: the new chat with the dry run (deps.startChat opens it and sends the words). */
  function act(verb, open) {
    if (verb !== 'test' || !open || !open.draft || !showOnceDraftIs(open.draft) || typeof deps.startChat !== 'function') return;
    if (typeof open.draft.skillMd !== 'string' || !open.draft.skillMd) return;
    deps.startChat(showOnceTestMessage(open.draft.skill || open.name || open.id, open.draft.skillMd));
  }
  return {view: v, html, load, act};
}
if (typeof module !== 'undefined') module.exports = {SHOW_ONCE_DRAFT_SOURCE, showOnceDraftIs, showOnceDraftPicturesHTML, showOnceTestMessage, showOnceTestHTML,
  createShowOnceDraftView};
