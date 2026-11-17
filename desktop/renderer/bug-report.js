/* ---------------- ATO-1466: Help › Report an Issue… ----------------
   Loaded before renderer.js; declares only.

   The issue used to carry the version, the OS, the arch and the agent's
   binary path, which is not enough to find the person in PostHog or Sentry.
   Like Zed and Claude Code, the button now shows a small sheet first: the
   text to send (editable), what the app adds under it (version, OS, surface,
   install channel, provider, model, engine), and two switches, "Include
   support ID" and "Include log tail". The log tail is the last 200 lines of
   agent.log, scrubbed in main (report-redact.ts scrubForIssue: keys, tokens,
   Bearer values, emails, home folder paths). The conversation is never part
   of it. With analytics off the support ID switch starts off; Settings ›
   Diagnostics still shows the ID so it can be copied by hand.

   A GitHub "new issue" link longer than ~8 KB is cut by the browser or
   GitHub, so when the log makes it too long the log goes to the clipboard
   (and to a file in Downloads) and the issue says to paste it.

   The pure half (details, body, link) is shared with the Node tests; the
   renderer half reads renderer.js's globals at call time. */

const BUG_REPORT_URL = 'https://github.com/AtomicBot-ai/atomic-agent/issues/new';
const BUG_REPORT_TITLE = '[desktop] ';
/* The link stays under this many characters (GitHub and browsers cut longer ones). */
const BUG_REPORT_URL_MAX = 8000;
const BUG_REPORT_TEMPLATE = 'What happened:\n\n\nWhat I expected:\n\n';
const BUG_REPORT_PASTE_NOTE = '**Log tail:** too long for the link. It is on your clipboard (and saved to a file in Downloads): paste it here.';

/* A path as an issue may show it: the home folder, and any other user's, as `~`.
   The agent binary sits under the home folder on most installs. */
function bugReportScrubPath(value, home) {
  let out = String(value == null ? '' : value);
  if (home && home.length > 1) out = out.split(home).join('~');
  return out.replace(/(?:\/Users|\/home)\/[^/\s"'`]+/g, '~').replace(/[A-Za-z]:\\Users\\[^\\\s"'`]+/g, '~');
}

/* The lines the app adds under the person's text. `f`: {version, build,
   platform, arch, installChannel, provider, model, engine, binary, home,
   supportId}; `includeId`: the switch. Missing facts read as "unknown". */
function bugReportDetailLines(f, includeId) {
  const x = f || {};
  const or = (v, d) => (v == null || v === '' ? d : String(v));
  const lines = [
    'Atomic Agent ' + or(x.version, '?') + (x.build ? ' (' + x.build + ')' : '') + ' · ' + or(x.platform, '?') + ' ' + or(x.arch, '?'),
    'Surface: desktop · installed via ' + or(x.installChannel, 'unknown'),
    'Provider: ' + or(x.provider, 'none') + ' · model ' + or(x.model, 'none'),
    'Engine: ' + or(x.engine, 'unknown'),
    'Agent: ' + (x.binary ? bugReportScrubPath(x.binary, x.home) : 'not started'),
  ];
  if (includeId && x.supportId) lines.push('Support ID: ' + x.supportId);
  return lines;
}

/* The log as a collapsed fenced block; a ``` inside it cannot close the fence. */
function bugReportLogBlock(log) {
  const body = String(log || '').replace(/```/g, '` ` `').trimEnd();
  return '<details><summary>Log tail (last 200 lines; keys, tokens, emails and home paths removed)</summary>\n\n```text\n'
    + body + '\n```\n\n</details>';
}

function bugReportBody(text, details, logPart) {
  return String(text || '').trimEnd() + '\n\n---\n' + details.join('\n') + (logPart ? '\n\n' + logPart : '');
}

function bugReportUrl(title, body) {
  return BUG_REPORT_URL + '?title=' + encodeURIComponent(title) + '&body=' + encodeURIComponent(body);
}

/* What the Open button does. `input`: {text, facts, includeId, includeLog,
   log, maxUrl}. Returns {url, body, clipboard}: `clipboard` is the log block
   to copy when it did not fit in the link (null when it did, or when there
   is no log to send). A text too long on its own is cut to fit, with a mark. */
function bugReportPlan(input) {
  const p = input || {};
  const max = p.maxUrl || BUG_REPORT_URL_MAX;
  const details = bugReportDetailLines(p.facts, !!p.includeId);
  const log = p.includeLog && String(p.log || '').trim() ? bugReportLogBlock(p.log) : '';
  let text = String(p.text || '');
  let body = bugReportBody(text, details, log);
  let url = bugReportUrl(BUG_REPORT_TITLE, body);
  let clipboard = null;
  if (url.length > max && log) {
    clipboard = log;
    body = bugReportBody(text, details, BUG_REPORT_PASTE_NOTE);
    url = bugReportUrl(BUG_REPORT_TITLE, body);
  }
  while (url.length > max && text.length > 0) {
    // An encoded character takes up to 9 link characters: cutting the overshoot over 9 never cuts too much.
    const cut = Math.max(16, Math.ceil((url.length - max) / 9));
    text = text.slice(0, Math.max(0, text.length - cut));
    body = bugReportBody(text + '\n\n_(cut to fit the link)_', details, clipboard ? BUG_REPORT_PASTE_NOTE : '');
    url = bugReportUrl(BUG_REPORT_TITLE, body);
  }
  return {url, body, clipboard};
}

/* ---- renderer side (globals from renderer.js, read at call time) ---- */

const BUGREP = {text: BUG_REPORT_TEMPLATE, includeId: false, includeLog: true, info: null, loading: false, sending: false, support: null, supportAsked: false};

/* What the window knows about itself right now. Each read is guarded: the
   sheet must open even when the agent is not up. */
function bugRepFacts() {
  const safe = (fn) => { try { return fn(); } catch (e) { return null; } };
  const b = (typeof BUILD !== 'undefined' && BUILD) || {};
  const info = BUGREP.info || {};
  const backend = safe(() => liveBackend());
  const engine = backend === 'local'
    ? (safe(() => llmManaged().engine) === 'llama-server' ? 'llama.cpp' : 'Atomic Core')
    : backend === 'custom' ? 'external server' : backend;
  return {
    version: b.version, build: b.build, platform: b.platform, arch: b.arch,
    installChannel: info.installChannel,
    provider: safe(() => { const p = activeProvider(); return p && p.id; }),
    model: safe(() => activeModel()),
    engine,
    binary: S.live && S.live.binary,
    home: safe(() => homeDir()),
    supportId: info.supportId || null,
  };
}

/** Open the sheet (act `help.report` → helpReport). */
function bugRepOpen() {
  BUGREP.text = BUG_REPORT_TEMPLATE; BUGREP.info = null; BUGREP.sending = false; BUGREP.includeLog = true; BUGREP.includeId = false;
  BUGREP.loading = !!(BR && BR.bugReportInfo);
  S.overlay = 'bugrep';
  render();
  if (!BUGREP.loading) return;
  BR.bugReportInfo().then((r) => {
    BUGREP.info = r && r.ok ? r : {};
    // With analytics off the ID is offered but not ticked.
    BUGREP.includeId = !!(BUGREP.info.supportId && BUGREP.info.analyticsEnabled);
  }, () => { BUGREP.info = {}; }).then(() => {
    BUGREP.loading = false;
    if (S.overlay === 'bugrep') render();
  });
}

function bugRepSwitch(act, on, label, sub) {
  return '<div class="tk-setrow bugrep-row"><div class="body"><div class="t">' + esc(label) + '</div>'
    + (sub ? '<div class="d">' + esc(sub) + '</div>' : '') + '</div>'
    + '<button class="tk-switch' + (on ? ' on' : '') + '" role="switch" aria-checked="' + !!on + '" aria-label="' + esc(label) + '" data-act="' + act + '"></button></div>';
}

/** The sheet, drawn by overlaysHTML while S.overlay === 'bugrep'. */
function bugRepHTML() {
  const facts = bugRepFacts();
  const info = BUGREP.info || {};
  const idSub = BUGREP.loading ? 'Reading…'
    : !facts.supportId ? 'There is no support ID on this computer yet.'
    : facts.supportId + (info.analyticsEnabled ? '' : ' · analytics is off, so this starts off');
  const logSub = BUGREP.loading ? 'Reading…'
    : info.logTail ? 'The last 200 lines of the agent log, with keys, tokens, emails and home folder paths taken out.'
    : 'The agent log is empty or could not be read.';
  const body = '<p class="sd-cap">This opens a new GitHub issue in your browser. Nothing is sent until you submit it there, and your chats are never included.</p>'
    + '<textarea id="bugrep-text" class="bugrep-text" rows="7" spellcheck="true" aria-label="What happened">' + esc(BUGREP.text) + '</textarea>'
    + bugRepSwitch('bugrep:id', BUGREP.includeId && !!facts.supportId, 'Include support ID', idSub)
    + bugRepSwitch('bugrep:log', BUGREP.includeLog, 'Include log tail', logSub)
    + '<div class="sd-cap bugrep-cap">Added under your text:</div>'
    + '<pre class="bugrep-pre">' + esc(bugReportDetailLines(facts, BUGREP.includeId).join('\n')) + '</pre>';
  return sheet('Report an issue', body,
    '<span class="grow"></span><button class="btn btn-s sm" data-act="close">Cancel</button>'
    + '<button class="btn btn-p sm" data-act="bugrep:send"' + (BUGREP.loading || BUGREP.sending ? ' disabled' : '') + '>' + ic('globe') + 'Open in browser</button>',
    'sheet-bugrep');
}

function bugRepAct(v) {
  if (v === 'id') { if (BUGREP.info && BUGREP.info.supportId) BUGREP.includeId = !BUGREP.includeId; render(); return; }
  if (v === 'log') { BUGREP.includeLog = !BUGREP.includeLog; render(); return; }
  if (v === 'send') { bugRepSend(); return; }
}

async function bugRepSend() {
  if (BUGREP.sending) return;
  const box = document.getElementById('bugrep-text');
  if (box) BUGREP.text = box.value;
  const info = BUGREP.info || {};
  const plan = bugReportPlan({text: BUGREP.text, facts: bugRepFacts(), includeId: BUGREP.includeId, includeLog: BUGREP.includeLog, log: info.logTail});
  BUGREP.sending = true;
  if (plan.clipboard) {
    // Before the browser takes focus: a clipboard write needs this window focused.
    await copyText(plan.clipboard, 'Log tail copied', 'Paste it into the issue');
    if (BR && BR.bugReportSaveLog) {
      BR.bugReportSaveLog().then((r) => { if (r && r.ok) toast('Log tail saved', r.path); }).catch(() => {});
    }
  }
  // As before ATO-1466: the support report is saved beside the issue (and counted).
  if (BR && BR.debugBundle) {
    BR.debugBundle('report').then((res) => {
      if (res && res.ok) toast('Report saved', res.path + ' — attach it if you want to');
    }).catch(() => {});
  }
  if (BR && BR.openExternal) BR.openExternal(plan.url);
  BUGREP.sending = false;
  if (S.overlay === 'bugrep') { S.overlay = null; render(); }
}

/* Settings › Diagnostics: a "Support ID" row with the row's own Copy button.
   Read once per window; with analytics off it is still shown, read only. */
function bugRepDiagRows() {
  if (!BUGREP.supportAsked && BR && BR.supportId) {
    BUGREP.supportAsked = true;
    BR.supportId().then((r) => {
      BUGREP.support = r && r.ok ? (r.supportId || '') : '';
      if (typeof diagRepaint === 'function') diagRepaint();
    }).catch(() => {});
  }
  return BUGREP.support ? [['Support ID', BUGREP.support]] : [];
}

if (typeof document !== 'undefined') {
  // The text survives a repaint (a switch flipped, the facts arriving).
  document.addEventListener('input', (e) => {
    if (e.target && e.target.id === 'bugrep-text') BUGREP.text = e.target.value;
  });
}

if (typeof window !== 'undefined') {
  // --smoke: open the sheet and read what the Open button would do.
  window.__bugReportOpen = () => bugRepOpen();
  window.__bugReportPlan = () => bugReportPlan({text: BUGREP.text, facts: bugRepFacts(), includeId: BUGREP.includeId, includeLog: BUGREP.includeLog, log: (BUGREP.info || {}).logTail});
}

if (typeof module !== 'undefined') {
  module.exports = {BUG_REPORT_URL, BUG_REPORT_URL_MAX, BUG_REPORT_TEMPLATE, BUG_REPORT_PASTE_NOTE,
    bugReportScrubPath, bugReportDetailLines, bugReportLogBlock, bugReportBody, bugReportUrl, bugReportPlan};
}
