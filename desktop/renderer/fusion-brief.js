/* ---------------- ATO-1754: what a Fusion worker was told ----------------
   Loaded before renderer.js; declares only. Shared by the renderer and the
   Node checks (test/fusion-brief.test.mjs).

   A worker was a black box: its transcript line said "worker X · model:
   started" and nothing about the task the orchestrator handed it. An agent
   with ATO-1754 puts two things on the worker's `started` frame:

     · `brief`: the message the worker's turn was started with, as sent
       (the task, the quoted request, the contract, the rules), clipped by
       the agent at 40,000 chars with a line saying so.
     · `model_note`: why the task is not on the model it asked for (a
       role with no model configured, a second local model this machine is
       not marked to hold). Absent when it ran where it asked to.

   The started line gets a quiet "What it was told" toggle. Closed by
   default, and the brief is put in the page only while it is open, so a
   fan-out of eight workers adds eight short buttons to the chat and no
   wall of text. An older agent sends neither field and the line stays as
   it was. */

/** The longest brief this side keeps (the agent's own cap, plus its cut line). */
const FZB_MAX_CHARS = 41_000;
/** The longest model note kept; the agent's are one sentence. */
const FZB_MAX_NOTE_CHARS = 500;

function fzbEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
}

/** The frame's brief and model note, each null when absent or blank. */
function fzbFromPayload(p) {
  const brief = p && typeof p.brief === 'string' && p.brief.trim() ? p.brief.slice(0, FZB_MAX_CHARS) : null;
  const note = p && typeof p.model_note === 'string' && p.model_note.trim() ? p.model_note.trim().slice(0, FZB_MAX_NOTE_CHARS) : null;
  return {brief, modelNote: note};
}

/**
 * The toggle and, when open, the block under a worker's started line.
 * `m` is the transcript item (`fzBrief`, `fzModel`, `fzNote`, `fzbOpen`);
 * `chevron(open)` draws the arrow. '' for a line with no brief.
 */
function fzbHTML(m, chevron) {
  if (!m || typeof m.fzBrief !== 'string' || !m.fzBrief) return '';
  const open = !!m.fzbOpen;
  const chev = typeof chevron === 'function' ? chevron(open) : '';
  let html = ' <span class="fzb"><button type="button" class="fzb-t" data-fzbrief="' + fzbEsc(m.id) + '" aria-expanded="' + open + '">'
    + chev + '<span>What it was told</span></button>';
  if (open) {
    html += '<span class="fzb-x">'
      + (m.fzModel ? '<span class="fzb-k">Model: ' + fzbEsc(m.fzModel) + '</span>' : '')
      + (m.fzNote ? '<span class="fzb-k fzb-note">' + fzbEsc(m.fzNote) + '</span>' : '')
      + '<span class="fzb-pre">' + fzbEsc(m.fzBrief) + '</span></span>';
  }
  return html + '</span>';
}

if (typeof module !== 'undefined') {
  module.exports = {FZB_MAX_CHARS, FZB_MAX_NOTE_CHARS, fzbFromPayload, fzbHTML};
}
