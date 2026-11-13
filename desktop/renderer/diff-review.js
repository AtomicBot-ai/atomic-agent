/* ATO-563 step 1: under a reply, each file the turn wrote can show its diff
   and be reverted to what it held before that reply.

   Data, all of it already in the window: the turn's write cards (S.log, the
   same cards the "Saved to" strip is built from, renderer.js
   cardWrittenPaths). An os.fs.edit card's result IS its unified diff; an
   applied os.fs.patch card's `patch` argument holds one section per file. A
   whole-file os.fs.write has no diff (it is new content, not a change), so
   that file shows no "Changes".

   Revert goes through POST /api/sessions/{id}/fs/restore (BR.fsRestore),
   which puts back the file checkpoint the agent took before the reply's
   first change of that file (ATO-1056): the content from before the reply,
   however many times the reply wrote it. The reply is named by its question
   (priorQuestions + its text, as the rollback names one), never "the newest
   copy". It is offered for every file the turn changed with a checkpointed
   tool (os.fs.write / edit / patch); the agent refuses when it kept no copy
   (an agent from before checkpoints, a file too large) and when a later
   reply changed the file too. The click arms a confirmation in place; only
   the second button reverts.

   Pure text work is in diff-lines.js. This file reads the renderer's
   globals (S, esc, ic, BR, toast, render, cardWrittenPaths, cardArgs,
   resolveAgentPath, homeDir, pathBase, priorQuestions) at call time, like the other
   renderer modules loaded before renderer.js. */

const DIFF_REVIEW = {
  open: new Set(),      // item id + '\n' + path: a "Changes" disclosure the person opened
  armed: null,          // {key, at}: the Revert waiting for its confirmation
  busy: new Set(),      // keys whose restore is in flight
  done: new Set(),      // keys reverted in this window
};
/* A double-click must not arm and confirm in one go (as TG_CONFIRM_MIN_MS). */
const DIFF_REVIEW_CONFIRM_MIN_MS = 400;
/* At most this many diffs per file under one reply (an edit loop is cut). */
const DIFF_REVIEW_MAX_DIFFS = 6;
/* The write tools the agent checkpoints before they run (src/tools/os/fs/fs-checkpoint-targets.ts). */
const DIFF_REVIEW_CHECKPOINTED = new Set(['os.fs.write', 'os.fs.edit', 'os.fs.patch']);

function diffReviewKey(itemId, path) { return String(itemId) + '\n' + String(path); }

/** The same file, however the card and fs.stat spelled it (`~` expanded). */
function diffReviewSamePath(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const home = typeof homeDir === 'function' ? homeDir() : '';
  const ex = (p) => (home && (p === '~' || /^~[\\/]/.test(p)) ? home + p.slice(1) : p);
  return ex(a) === ex(b);
}

/** Fill `diffs` and `restorable` on each of an assistant item's attached
    files, from the write cards of its turn. Called from refreshAttachments
    when the strip's files are (re)stated, never from render(). */
function diffReviewAnnotate(m, cwd) {
  const files = m && m.attach;
  if (!files || !files.length || typeof S === 'undefined') return;
  for (const f of files) { f.diffs = []; f.restorable = false; }
  const idx = S.log.indexOf(m);
  for (let i = idx - 1; i >= 0; i--) {
    const c = S.log[i];
    // A steer joins the turn its question opened; only a new question ends it.
    if (c.k === 'user') { if (c.steered) continue; break; }
    const written = cardWrittenPaths(c, cwd);
    if (!written.length) continue;
    const out = String(c.out || '');
    for (const f of files) {
      if (!written.some((p) => diffReviewSamePath(p, f.path))) continue;
      let diff = null;
      if (c.name === 'os.fs.edit' && looksLikeUnifiedDiff(out)) diff = out;
      else if (c.name === 'os.fs.patch') {
        const a = cardArgs(c) || {};
        const root = resolveAgentPath(a.rootDir, cwd) || cwd || (S.live && S.live.workingDir) || '';
        const sec = typeof a.patch === 'string' ? diffSectionFor(a.patch, f.path, root) : null;
        if (sec && looksLikeUnifiedDiff(sec)) diff = sec;
      }
      // Walking back, so the earliest change of the turn ends up first.
      if (diff && f.diffs.length < DIFF_REVIEW_MAX_DIFFS) f.diffs.unshift(diff);
      // The agent took a checkpoint before this card changed the file.
      if (DIFF_REVIEW_CHECKPOINTED.has(c.name)) f.restorable = true;
    }
  }
}

/** The question that opened `m`'s turn (steers skipped), or null. */
function diffReviewQuestion(m) {
  const idx = S.log.indexOf(m);
  for (let i = idx - 1; i >= 0; i--) {
    const x = S.log[i];
    if (x.k === 'user' && !x.steered) return x;
  }
  return null;
}

/** Did a later turn (after the next question) write the file again? Putting
    back this reply's starting point would undo that one too, so the window
    refuses, as the agent does (changed_later). */
function diffReviewWrittenLater(m, path, cwd) {
  const idx = S.log.indexOf(m);
  let later = false;
  for (let i = idx + 1; i < S.log.length; i++) {
    const x = S.log[i];
    if (x.k === 'user' && !x.steered) { later = true; continue; }
    if (later && cardWrittenPaths(x, cwd).some((p) => diffReviewSamePath(p, path))) return true;
  }
  return false;
}

/** The row under one "Saved to" line: Changes (a disclosure) and Revert. '' when it has neither. */
function diffReviewRowHTML(m, f) {
  const diffs = f.diffs || [];
  if (!diffs.length && !f.restorable) return '';
  const key = diffReviewKey(m.id, f.path);
  const ids = ' data-item="' + esc(m.id) + '" data-path="' + esc(f.path) + '"';
  let html = '<div class="dr-row">';
  if (diffs.length) {
    let add = 0, del = 0;
    for (const d of diffs) { const n = diffCounts(d); add += n.add; del += n.del; }
    html += '<details class="dr-diff"' + (DIFF_REVIEW.open.has(key) ? ' open' : '') + '>'
      + '<summary data-diffrev="toggle"' + ids + '>' + ic('chevR') + 'Changes'
      + ' <span class="dr-count"><span class="dr-add">+' + add + '</span> <span class="dr-del">−' + del + '</span></span></summary>'
      + '<div class="dr-body">' + diffs.map((d) => diffLinesHTML(d, esc)).join('<span class="dr-sep"></span>') + '</div>'
      + '</details>';
  }
  if (f.restorable) {
    const name = esc(f.name || pathBase(f.path) || f.path);
    if (DIFF_REVIEW.done.has(key)) html += '<span class="dr-done">' + ic('check') + 'Reverted</span>';
    else if (DIFF_REVIEW.busy.has(key)) html += '<span class="dr-done">Reverting…</span>';
    else if (DIFF_REVIEW.armed && DIFF_REVIEW.armed.key === key) {
      html += '<span class="dr-confirm">Put ' + name + ' back as it was before this reply? What the agent wrote there is replaced; a file this reply created is removed.</span>'
        + '<button class="btn sm btn-danger" data-diffrev="confirm"' + ids + '>Revert</button>'
        + '<button class="btn sm btn-g" data-diffrev="cancel"' + ids + '>Cancel</button>';
    } else {
      html += '<button class="btn sm btn-g dr-revert" data-diffrev="revert"' + ids
        + ' title="Put back the content this file had before this reply changed it">Revert</button>';
    }
  }
  return html + '</div>';
}

function diffReviewRepaint() {
  if (typeof repaintTranscript === 'function' && repaintTranscript()) return;
  render();
}

/** The click handler's hook: true when the click was one of these controls. */
function diffReviewClick(t) {
  const el = t && t.closest ? t.closest('[data-diffrev]') : null;
  if (!el) return false;
  const verb = el.dataset.diffrev, itemId = el.dataset.item, path = el.dataset.path;
  const key = diffReviewKey(itemId, path);
  if (verb === 'toggle') {
    // The click lands before <details> toggles: the new state is the opposite of `open`.
    const det = el.parentElement;
    if (det && det.open) DIFF_REVIEW.open.delete(key); else DIFF_REVIEW.open.add(key);
    return true;
  }
  if (verb === 'revert') { DIFF_REVIEW.armed = {key, at: Date.now()}; diffReviewRepaint(); return true; }
  if (verb === 'cancel') { DIFF_REVIEW.armed = null; diffReviewRepaint(); return true; }
  if (verb === 'confirm') {
    const armed = DIFF_REVIEW.armed;
    if (!armed || armed.key !== key || Date.now() - armed.at < DIFF_REVIEW_CONFIRM_MIN_MS) return true;
    DIFF_REVIEW.armed = null;
    diffReviewRevert(itemId, path);
    return true;
  }
  return true;
}

async function diffReviewRevert(itemId, path) {
  const key = diffReviewKey(itemId, path);
  const m = S.log.find((x) => x.id === itemId);
  const name = pathBase(path) || path;
  const cwd = (S.live && S.live.workingDir) || null;
  if (!m) { diffReviewRepaint(); return; }
  if (diffReviewWrittenLater(m, path, cwd)) {
    toast('Not reverted', 'the agent changed ' + name + ' again later in this chat; revert it from the latest reply', 'bad');
    diffReviewRepaint();
    return;
  }
  if (!BR || !BR.fsRestore || !S.agentSession) {
    toast('Not reverted', 'this window cannot reach the agent to put the file back', 'bad');
    diffReviewRepaint();
    return;
  }
  // The reply's question: the agent restores what the file held before it.
  const q = diffReviewQuestion(m);
  const prior = q && typeof priorQuestions === 'function' ? priorQuestions(q) : null;
  if (!q || !Number.isInteger(prior)) {
    toast('Not reverted', 'this window could not tell which reply to revert', 'bad');
    diffReviewRepaint();
    return;
  }
  DIFF_REVIEW.busy.add(key);
  diffReviewRepaint();
  let r = null;
  try { r = await BR.fsRestore(S.agentSession, path, prior, String(q.text || '')); } catch (e) { r = {ok: false, error: String((e && e.message) || e)}; }
  DIFF_REVIEW.busy.delete(key);
  if (r && r.ok) {
    DIFF_REVIEW.done.add(key);
    if (r.action === 'delete') toast('Removed ' + name, 'this reply created it, so going back means it is gone');
    else if (r.action === 'unchanged') toast(name + ' already as it was', 'it has the content it had before this reply');
    else toast('Reverted ' + name, 'it has the content it had before this reply');
  } else {
    toast('Not reverted', (r && r.error) || 'the agent did not put the file back', 'bad');
  }
  diffReviewRepaint();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {diffReviewKey, diffReviewSamePath, diffReviewQuestion, DIFF_REVIEW};
}
