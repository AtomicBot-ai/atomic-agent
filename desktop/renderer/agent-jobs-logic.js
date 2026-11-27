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
    // A backspace removes the character before it (one pass: a spinner line can hold thousands).
    if (out.indexOf('\b') >= 0) {
      const kept = [];
      for (const c of out) { if (c === '\b') kept.pop(); else kept.push(c); }
      out = kept.join('');
    }
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

/**
 * The terminal size that fits the screen box, from its inner size and one
 * character's width and line height. Bounded like the agent's own limits.
 */
function ajFitSize(width, height, charW, lineH) {
  if (!(width > 0 && height > 0 && charW > 0 && lineH > 0)) return null;
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  return {cols: clamp(Math.floor(width / charW), 20, 500), rows: clamp(Math.floor(height / lineH), 5, 200)};
}

/** Is `el` a field the person types into (the chat composer, a search box)? Then a prompt does not take the caret. */
function ajIsTextField(el) {
  if (!el || typeof el !== 'object') return false;
  if (el.isContentEditable) return true;
  const tag = String(el.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA') return true;
  if (tag !== 'INPUT') return false;
  return !/^(checkbox|radio|button|submit|reset|range|color|file|image)$/i.test(String(el.type || 'text'));
}

/**
 * The toast at a password prompt, [title, body]. It promises only what the
 * agent does (route-shell-jobs.ts): the typing never becomes a chat
 * message, and with Hide typing on an echo of it is masked for the model
 * when the value can be masked (8 characters or more, not a plain word).
 */
function ajPromptToast(opened, panelOpen) {
  // The "Agent job needs you" chip is drawn only while the panel is folded.
  const where = opened ? 'Type it in the terminal panel.'
    : panelOpen ? 'Click the field in the terminal panel under the chat to type it.'
      : 'Click \u201cAgent job needs you\u201d over the chat box to type it.';
  return ['The agent\u2019s command is asking you', where + ' It goes to the command, not to the chat. '
    + 'If the command shows it again, the agent sees it hidden, unless it is short or a single plain word.'];
}

/** After a hidden send, [title, body] when the agent could not mask the value; null when it did. */
function ajSecretSentNote(data) {
  if (data && data.masked === true) return null;
  if (data && data.masked === false) {
    return ['Not hidden from the agent', 'That answer is short or a plain word, so if the command prints it back the agent can see it.'];
  }
  return ['Not hidden from the agent', 'This version of the agent can\u2019t hide it if the command prints it back. Update Atomic Agent.'];
}

/** What Send puts on the job's input: the text, then Enter. */
function ajInputText(text, enter) {
  return String(text == null ? '' : text) + (enter === false ? '' : '\n');
}

if (typeof module !== 'undefined') {
  module.exports = {AJ_MAX_LINES, AJ_MAX_RAW, ajEsc, ajScreenText, ajAppendRaw, ajLooksSecret, ajTabLabel, ajIsLive,
    ajStateLine, ajMergeJobs, ajJobsFrom, ajChipText, ajInputText, ajFitSize, ajIsTextField, ajPromptToast, ajSecretSentNote};
}
