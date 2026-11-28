/* ---------------- ATO-1014: Hand off to Claude Code / Codex ----------------
   Loaded before renderer.js; declares only. The pure half is shared with the
   Node checks (test/handoff-out.test.mjs); the renderer half reads
   renderer.js globals at call time, as handoff.js does.

   The way back from handoff.js: this chat, written up as a Markdown brief
   (`atag handoff --to claude|codex`, main/handoff-out.ts) that Claude Code or
   Codex can start from. The sheet shows where the file went and its first
   lines, and offers Copy brief, Show in Finder / Explorer / Folder and, on
   macOS, Open in Terminal:
   a new Terminal window in the chat's folder with `claude "$(cat '<file>')"`
   typed in and not run (terminal-open.ts), so the person sees it and presses
   Enter themselves.

   Opened from the chat row's menu ("Hand off to Claude Code / Codex…") and
   from the palette (the open chat). */

const HOUT_TARGET_ROWS = [['claude', 'Claude Code'], ['codex', 'Codex']];

/** Plain HTML escaping, so the pure half needs nothing from renderer.js. */
function houtEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
}

function houtLabel(to) {
  const row = HOUT_TARGET_ROWS.find(([id]) => id === to);
  return row ? row[1] : 'Claude Code';
}

/** The file's name, POSIX or Windows path. */
function houtFileName(path) {
  const parts = String(path || '').split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(path || '');
}

/** The result block: the file's name (the full path on hover) and its first lines. Every chat-made string is escaped. */
function houtResultHTML(res) {
  if (!res || !res.ok) return '';
  return '<div class="hout-file"><span class="s">Brief</span> <code title="' + houtEsc(res.path) + '">' + houtEsc(houtFileName(res.path)) + '</code></div>'
    + '<pre class="hout-preview">' + houtEsc(res.preview) + '</pre>';
}

/** ATO-2744: a failed run as {text, detail} for the notice: main's sentence, its raw words under Details. */
function houtErrorOf(res, thrown) {
  if (thrown !== undefined) return {text: "Couldn't write the brief. Try again.", detail: String((thrown && thrown.message) || thrown || '')};
  return {text: (res && res.error) || "Couldn't write the brief. Try again.", detail: (res && res.detail) || ''};
}

/** What the caption under the switch says for `to`. */
function houtCaption(to, terminal) {
  const label = houtLabel(to);
  return 'A Markdown brief of this chat (the task, what was done, what is left) for ' + label + ' to start from.'
    + (terminal ? ' Open in Terminal types the command for you; nothing runs until you press Enter.' : ' Copy it and paste it into ' + label + '.');
}

/** Whether to offer Open in Terminal: main said how (macOS, a brief that fits) and the bridge is there. */
function houtTerminalOk(res, br) {
  return !!(res && res.ok && res.terminal && res.terminal.command && br && typeof br.terminalOpenWithCommand === 'function');
}

/* ---- renderer side (globals from renderer.js, read at call time) ---- */

const HOUT = {id: '', to: 'claude', loading: false, error: null, res: null, seq: 0};

async function houtRun() {
  if (!BR || !BR.handoffTo) { HOUT.error = 'This build cannot hand a chat to Claude Code or Codex.'; render(); return; }
  const seq = ++HOUT.seq;
  HOUT.loading = true; HOUT.error = null; HOUT.res = null;
  render();
  let thrown;
  const res = await Promise.resolve(BR.handoffTo(HOUT.to, HOUT.id)).catch((e) => { thrown = e; return null; });
  if (seq !== HOUT.seq) return;   // the person switched the target meanwhile
  HOUT.loading = false;
  if (!res || !res.ok) { HOUT.error = houtErrorOf(res, thrown); render(); return; }
  HOUT.res = res;
  render();
}

function handoffOutSheetHTML() {
  const res = HOUT.res;
  const term = houtTerminalOk(res, BR);
  let body = segControl(HOUT_TARGET_ROWS, HOUT.to, 'hout:to:')
    + '<p class="sd-cap">' + esc(houtCaption(HOUT.to, term)) + '</p>';
  if (HOUT.error) body += herrNoticeHTML(HOUT.error, {icon: ic('alert')});
  if (HOUT.loading) body += '<div class="tk-empty"><span class="tk-spin"></span><p>Writing the brief…</p></div>';
  else body += houtResultHTML(res);
  const ready = !!(res && res.ok) && !HOUT.loading;
  const dis = ready ? '' : ' disabled';
  return sheet('Hand off to ' + houtLabel(HOUT.to),
    body,
    '<button class="btn btn-g sm" data-act="hout:copy"' + dis + '>' + ic('copy') + 'Copy brief</button>'
    + '<button class="btn btn-g sm" data-act="hout:reveal"' + dis + '>' + ic('folder') + esc(fileManagerName()) + '</button>'
    + (term ? '<button class="btn btn-p sm" data-act="hout:term"' + dis + '>' + ic('term') + 'Open in Terminal</button>' : '')
    + '<span class="grow"></span><button class="btn btn-s sm" data-act="close">Close</button>',
    'sheet-hout');
}

function houtTerminal() {
  const res = HOUT.res;
  // A toast has no Details: only the first sentence of terminal-open's words, never the raw tail.
  const fail = (why) => toast("Couldn't open Terminal", (typeof herrSentence === 'function' ? herrSentence(why) : '') || 'Copy the brief and paste it into ' + houtLabel(HOUT.to) + '.', 'bad');
  if (!houtTerminalOk(res, BR)) { fail(); return; }
  // ATO-1424 answers {ok:true, cwd, usedHome} or {ok:false, error, message}.
  Promise.resolve().then(() => BR.terminalOpenWithCommand({command: res.terminal.command, cwd: res.terminal.cwd || null}))
    .then((r) => {
      if (!r || r.ok !== true) { fail(r && r.message); return; }
      toast('Opened in Terminal', 'Press Enter there to start ' + res.label + ' with the brief.');
    }, () => fail());
}

/** `houtopen:<chat id>` (row menu; empty = the open chat) and `hout:<verb>`: to:<target> · copy · reveal · term. */
function handoffOutAct(k, v) {
  if (k === 'houtopen') {
    const id = v || S.sessionId;
    if (!id) { toast('No chat to hand off', 'Open a chat first.', 'bad'); return; }
    HOUT.id = id; HOUT.error = null; HOUT.res = null;
    S.overlay = 'hout';
    houtRun();
    return;
  }
  if (v.indexOf('to:') === 0) {
    const to = v.slice('to:'.length);
    if (!HOUT_TARGET_ROWS.some(([id]) => id === to) || to === HOUT.to) return;
    HOUT.to = to;
    houtRun();
    return;
  }
  const res = HOUT.res;
  if (!res || !res.ok) return;
  if (v === 'copy') { copyText(res.brief, 'Brief copied', 'Paste it into ' + res.label + '.'); return; }
  if (v === 'reveal') {
    if (!BR || !BR.handoffReveal) return;
    // A toast has no Details: the sentence only, the raw words stay out of it.
    Promise.resolve(BR.handoffReveal(res.path)).then((r) => {
      if (!r || !r.ok) toast("Couldn't show the brief", (r && r.error) || 'Hand the chat off again.', 'bad');
    }, () => toast("Couldn't show the brief", 'Hand the chat off again.', 'bad'));
    return;
  }
  if (v === 'term') { houtTerminal(); return; }
}

if (typeof module !== 'undefined') module.exports = {HOUT_TARGET_ROWS, houtEsc, houtLabel, houtFileName, houtResultHTML, houtErrorOf, houtCaption, houtTerminalOk};
