/* ---------------- ATO-2740: the facts import's titles, close question, error words, file buttons ----------------
   Loaded before import-facts.js (index.html); declares only. import-facts.js
   looks these up at run time and, in Node (test/import-facts-steps.test.mjs),
   requires this file.

   - Each step has its own title: "Here is what I learned about you" only
     once there is something to show.
   - Closing (× or Skip) while the agent reads, or with found facts not yet
     saved, asks first, the way ChatGPT's and Claude's data import and macOS
     Migration Assistant ask before a cancel drops work. "Keep importing" /
     "Keep reviewing" is the default; while reading, "Stop and review" keeps
     what was found (the job's own Stop), so the found facts can still be saved.
   - An error shows in plain words; the agent's own text sits behind
     "Details", the way the setup screen shows a provider error (ob-errmore).
   - On Windows and Linux the system dialog picks a file or a folder, not
     both, so the pick step offers two buttons; macOS keeps one. */

const IFACT_ERROR_FALLBACK = {
  info: 'Could not reach the agent. Check that it is running, then try again.',
  start: 'Could not start reading your chats. Try again.',
  job: 'Reading stopped because of a problem.',
  poll: 'Lost touch with the agent for a moment. Still trying.',
  stop: 'Could not stop reading. Try again.',
  save: 'Could not save the facts you picked. Try again.',
};
/** Raw text, matched in order, to the words the window shows. Only for text that is not already plain words. */
const IFACT_ERROR_RULES = [
  [/the model did not answer/i, 'The model did not answer for any part of your chats. Check that the model is running in Settings › Models, then try again.'],
  [/ENOENT|no such file/i, 'That export is not there any more. Choose it again.'],
  [/EACCES|EPERM|permission denied|operation not permitted/i, 'The agent is not allowed to open that export. Move it to a folder you own, such as Downloads, and try again.'],
  [/ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed|Could not reach the agent/i, 'Could not reach the agent. Check that it is running, then try again.'],
  [/central directory|end of data|zip|corrupt|signature/i, 'That file could not be opened as a data export. Download the export again and choose it.'],
  [/conversations\.json|no conversations|no chats/i, 'No chats were found in that export. Choose the whole Export data .zip, or the folder it was unpacked to.'],
  [/timed? ?out|timeout/i, 'The model took too long to answer. Try again, or pick another model.'],
];
/** Main's wrappers around the agent's own text (main/import-facts.ts), and what Electron adds to a thrown error. */
const IFACT_RAW_MARKS = [/^Could not reach the agent: /, /^The agent could not read that: /, /^The agent answered HTTP \d+/, /Error invoking remote method/, /^[A-Za-z]*Error\b/];

function ifactStepsName(st) {
  const names = {claude: 'Claude', chatgpt: 'ChatGPT'};
  return (st && names[st.source]) || 'ChatGPT';
}
function ifactStepsEnded(job) { return !!job && (job.state === 'done' || job.state === 'stopped' || job.state === 'failed'); }
function ifactStepsList(st) { return (st && st.job && Array.isArray(st.job.candidates)) ? st.job.candidates : []; }

/** The sheet's title for the step on screen. */
function ifactStepTitle(st) {
  const stage = st && st.stage;
  if (stage === 'pick') return 'Choose your ' + ifactStepsName(st) + ' export';
  if (stage === 'choose') return 'Find facts about you';
  if (stage === 'running') return 'Reading your chats';
  if (stage === 'review' || stage === 'saving') return ifactStepsList(st).length ? 'Here is what I learned about you' : 'Nothing new found';
  if (stage === 'done') return 'Saved to memory';
  if (stage === 'error') return 'Could not bring in facts';
  return 'Bring in facts about you';
}

/** How many facts closing now would drop: found so far while reading, listed once read. */
function ifactFoundCount(st) {
  if (!st || !st.job) return 0;
  if (st.stage === 'running') return Math.max(0, Number(st.job.found) || 0);
  return ifactStepsList(st).length;
}

/** × or Skip asks first while the agent reads, or while found facts wait unsaved. */
function ifactCloseNeedsAsk(st) {
  if (!st || !st.open || !st.job) return false;
  if (st.stage === 'running') return !ifactStepsEnded(st.job);
  if (st.stage === 'review') return ifactStepsList(st).length > 0;
  return false;
}

function ifactFactsWord(n) { return n + (n === 1 ? ' fact' : ' facts'); }

/** The question's words and buttons; null when closing loses nothing. `picked` is how many are ticked. */
function ifactCloseAsk(st, picked) {
  if (!ifactCloseNeedsAsk(st)) return null;
  const n = ifactFoundCount(st);
  if (st.stage === 'running') {
    return n > 0
      ? {title: 'Stop importing?', text: ifactFactsWord(n) + ' found so far will be lost. To keep them, stop reading and pick which to save.',
        keep: 'Keep importing', actions: [{act: 'ask:discard', label: 'Discard'}, {act: 'ask:review', label: 'Stop and review'}]}
      : {title: 'Stop importing?', text: 'The agent stops reading your chats. Nothing has been found yet.',
        keep: 'Keep importing', actions: [{act: 'ask:discard', label: 'Stop'}]};
  }
  const actions = [{act: 'ask:discard', label: 'Discard'}];
  if (picked > 0) actions.push({act: 'ask:save', label: 'Save ' + picked});
  return {title: 'Close without saving?', text: ifactFactsWord(n) + ' found will be lost. Nothing has been saved yet.', keep: 'Keep reviewing', actions};
}

/** {body, foot} for the question; the default button is last and is the one focused. */
function ifactCloseAskHTML(ask, esc) {
  const body = '<p class="ifact-ask" role="alert">' + esc(ask.text) + '</p>';
  const foot = '<span class="grow"></span>'
    + ask.actions.map((a) => '<button class="btn sm" type="button" data-ifact="' + esc(a.act) + '">' + esc(a.label) + '</button>').join('')
    + '<button class="btn btn-p sm" type="button" data-ifact="ask:keep">' + esc(ask.keep) + '</button>';
  return {body, foot};
}

/**
 * {text, detail}: plain words for the window, and the raw text for Details.
 * `kind` picks the fallback (IFACT_ERROR_FALLBACK); `raw` is true for text
 * that never was meant for people (a thrown error, the agent's job error).
 * Main's own plain words pass through with no Details.
 */
function ifactErrorView(message, kind, raw) {
  const s = String(message == null ? '' : message).trim();
  const fallback = IFACT_ERROR_FALLBACK[kind] || 'Something went wrong. Try again.';
  if (!s) return {text: fallback, detail: ''};
  const isRaw = !!raw || kind === 'job' || IFACT_RAW_MARKS.some((re) => re.test(s));
  if (!isRaw) return {text: s, detail: ''};
  const hit = IFACT_ERROR_RULES.find((r) => r[0].test(s));
  return {text: hit ? hit[1] : fallback, detail: s};
}

/** The error line, with Details only while that same error stands (st.errorDetail = {for, text}). */
function ifactErrorHTML(st, esc) {
  if (!st || !st.error) return '';
  const d = st.errorDetail;
  const detail = d && d.for === st.error ? d.text : '';
  return '<p class="tk-help tk-help--err" role="alert">' + esc(st.error) + '</p>'
    + (detail ? '<details class="ifact-errmore"><summary>Details</summary><pre>' + esc(detail) + '</pre></details>' : '');
}

/** The pick buttons: one on macOS (its dialog takes a file or a folder), two elsewhere. */
function ifactPickButtonsHTML(platform) {
  if (!platform || platform === 'darwin') return '<button class="btn sm" type="button" data-ifact="pick">Choose…</button>';
  return '<button class="btn sm" type="button" data-ifact="pick:file">Choose ZIP file</button>'
    + '<button class="btn sm" type="button" data-ifact="pick:folder">Choose folder</button>';
}

if (typeof module !== 'undefined') {
  module.exports = {IFACT_ERROR_FALLBACK, ifactStepTitle, ifactFoundCount, ifactCloseNeedsAsk, ifactCloseAsk, ifactCloseAskHTML,
    ifactErrorView, ifactErrorHTML, ifactPickButtonsHTML};
}
