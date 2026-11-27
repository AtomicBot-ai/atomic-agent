/* ---------------- ATO-2485: the agent's jobs in the terminal panel (logic) ----------------
   Loaded before agent-jobs.js; declares only. Shared by the panel and the
   Node checks (test/agent-jobs.test.mjs).

   The agent runs an interactive command as a kept job on its own
   pseudo-terminal (`os.shell.run` with `tty: true`, ATO-2277). The panel
   attaches to that job: it shows the output as it comes and lets the
   person take over the typing (a password, a y/n the agent should not
   answer). What the person types goes to the job only, never into the
   chat or to the model (src/http/route-shell-jobs.ts).

   Output arrives raw, as the program printed it: colour codes, carriage
   returns of a progress bar, backspaces. ajScreenText turns it into the
   lines a terminal would be showing, without a terminal emulator. */

/** Lines the panel keeps per job; older ones scroll away. */
const AJ_MAX_LINES = 4000;
/** Raw characters kept per job before the oldest are dropped. */
const AJ_MAX_RAW = 512 * 1024;
/** Characters of the command a tab label shows. */
const AJ_LABEL_CHARS = 40;

function ajEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
}

/** Raw job output as the lines a terminal would show. */
function ajScreenText(raw) {
  const plain = String(raw == null ? '' : raw)
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-Z\\-_]/g, '')
    .replace(/\r\n/g, '\n');
  const lines = plain.split('\n').map((line) => {
    // A bare carriage return goes back to the line start: what follows overwrites it.
    let out = '';
    for (const part of line.split('\r')) out = part.length >= out.length ? part : part + out.slice(part.length);
    // A backspace removes the character before it.
    while (out.indexOf('\b') >= 0) out = out.replace(/[^\b]?\u0008/, '');
    return out.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  });
  return lines.slice(-AJ_MAX_LINES).join('\n');
}

/** Append a slice, keeping at most AJ_MAX_RAW characters. */
function ajAppendRaw(prev, text) {
  const all = String(prev || '') + String(text || '');
  return all.length > AJ_MAX_RAW ? all.slice(all.length - AJ_MAX_RAW) : all;
}

/** Does the screen end at a prompt for something secret? Then the field hides what is typed. */
function ajLooksSecret(screen) {
  const lines = String(screen || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines.length ? lines[lines.length - 1] : '';
  return /(password|passphrase|passcode|\bpin\b|token|secret)[^\n]*[:?]\s*$/i.test(last) && last.length <= 200;
}

/** "Agent job: npm init" */
function ajTabLabel(job) {
  const line = String(job && job.commandLine || '').replace(/\s+/g, ' ').trim();
  const head = line.length > AJ_LABEL_CHARS ? line.slice(0, AJ_LABEL_CHARS - 1) + '…' : line;
  return 'Agent job: ' + (head || 'command');
}

function ajIsLive(job) {
  return !!job && job.state === 'running';
}

/** One short line under the output: what state the job is in. */
function ajStateLine(job) {
  if (!job) return '';
  if (job.state === 'running') return job.interactive ? 'Running. You can take over the typing.' : 'Running. This job does not take typing.';
  if (job.state === 'killed') return 'Stopped.';
  if (typeof job.exitCode === 'number') return job.exitCode === 0 ? 'Finished.' : 'Ended with exit code ' + job.exitCode + '.';
  return 'Ended.';
}

/**
 * The tabs to draw: every job the agent lists, plus ended ones it no
 * longer lists that the person has not closed (so the last screen stays).
 */
function ajMergeJobs(prev, listed, closed) {
  const shut = closed || {};
  const byId = new Map();
  for (const j of Array.isArray(prev) ? prev : []) {
    if (!shut[j.id]) byId.set(j.id, {...j, state: ajIsLive(j) ? 'exited' : j.state});
  }
  for (const j of Array.isArray(listed) ? listed : []) {
    if (!j || typeof j.id !== 'number' || shut[j.id]) continue;
    byId.set(j.id, j);
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/** The jobs out of the agent's list answer, checked. */
function ajJobsFrom(data) {
  const jobs = data && Array.isArray(data.jobs) ? data.jobs : [];
  return jobs.filter((j) => j && typeof j.id === 'number' && typeof j.commandLine === 'string' && typeof j.state === 'string');
}

/** The chip's words when the panel is folded. */
function ajChipText(jobs, needsYou) {
  const live = jobs.filter(ajIsLive).length;
  if (needsYou) return 'Agent job needs you';
  if (live === 1) return 'Agent job running';
  if (live > 1) return live + ' agent jobs running';
  return jobs.length === 1 ? 'Agent job ended' : 'Agent jobs ended';
}

/** What Send puts on the job's input: the text, then Enter. */
function ajInputText(text, enter) {
  return String(text == null ? '' : text) + (enter === false ? '' : '\n');
}

if (typeof module !== 'undefined') {
  module.exports = {AJ_MAX_LINES, AJ_MAX_RAW, ajEsc, ajScreenText, ajAppendRaw, ajLooksSecret, ajTabLabel, ajIsLive,
    ajStateLine, ajMergeJobs, ajJobsFrom, ajChipText, ajInputText};
}
