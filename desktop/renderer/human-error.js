/* ---------------- ATO-2744: a human sentence, the raw words under Details ----------------
   Loaded before every feature module; declares only. Pure: no DOM, no IPC,
   no renderer.js globals, so the panels and the Node checks
   (test/human-error.test.mjs) share it.

   A panel that failed says what happened in one plain sentence, with what to
   do when there is something to do. What the system said (an errno, git's
   stderr, a path) stays one click away under Details, the way the first-run
   error (ob-errmore) and a failed turn (sysDetailHTML) already do it.

   An error here is {text, hint, detail}: `text` the sentence, `hint` an
   optional second line, `detail` the raw words (never shown folded open).
   A plain string is a sentence with nothing under Details. */

function herrEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
}

/** The raw words of anything thrown or answered: an Error's message, a string, '' for nothing. */
function herrRaw(e) {
  if (e == null) return '';
  if (typeof e === 'string') return e.trim();
  if (typeof e === 'object' && typeof e.message === 'string') return e.message.trim();
  return String(e).trim();
}

/** The errno code in a Node error ("EPERM: operation not permitted, open '/x'"), or ''. */
function herrCode(raw) {
  const m = /\b(E[A-Z][A-Z0-9]{2,})\b/.exec(herrRaw(raw));
  return m ? m[1] : '';
}

/** EPERM / EACCES, or the words a shell tool uses for them. */
function herrIsPermission(raw) {
  const s = herrRaw(raw);
  return /^(EPERM|EACCES)$/.test(herrCode(s)) || /permission denied|operation not permitted/i.test(s);
}

/** The last part of a path, POSIX or Windows. */
function herrBase(path) {
  const parts = String(path || '').split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(path || '');
}

/** Whether `t` reads as written for a person: one line, a capital first, a stop at its end, and no
    errno, "fatal:" or path in it. */
function herrHuman(t) {
  const s = String(t || '');
  return /^[A-Z]/.test(s) && /[.!?]$/.test(s) && !/\n/.test(s) && !herrCode(s)
    && !/\b(fatal|error|errno):/i.test(s) && !/[\\/][^\s\\/]+[\\/]/.test(s);
}

/** Words another module wrote, which may carry raw text: all of them when they read as a sentence for a
    person, else their first sentence when that one does, else ''. */
function herrSentence(s) {
  const t = herrRaw(s);
  if (herrHuman(t)) return t;
  const m = /^[^\n]*?[.!?](?=\s|$)/.exec(t);
  return m && herrHuman(m[0]) ? m[0] : '';
}

/** {text, hint, detail} from a string, such an object, or nothing. */
function herrOf(e) {
  if (!e) return {text: '', hint: '', detail: ''};
  if (typeof e === 'string') return {text: e, hint: '', detail: ''};
  return {text: String(e.text || ''), hint: String(e.hint || ''), detail: herrRaw(e.detail)};
}

/** A file or folder that could not be read. `what` names it ("this file", "report.pdf"); `platform` is process.platform's word. */
function herrFsRead(raw, what, platform) {
  const detail = herrRaw(raw);
  const name = what || 'this file';
  if (herrIsPermission(detail)) {
    return {
      text: "Atomic Agent isn't allowed to read " + name + '.',
      hint: platform === 'darwin'
        ? 'Allow Atomic Agent in System Settings › Privacy & Security › Files and Folders, or turn on Full Disk Access for it.'
        : 'Check that your user account can open it.',
      detail,
    };
  }
  const code = herrCode(detail);
  if (code === 'ENOENT') return {text: "Couldn't find " + name + '. It may have been moved or deleted.', hint: '', detail};
  if (code === 'EBUSY') return {text: "Couldn't read " + name + '. Another app is using it.', hint: '', detail};
  return {text: "Couldn't read " + name + '.', hint: '', detail};
}

/** A git worktree that could not be made (project workers): the known cases in words. */
function herrGitWorktree(raw) {
  const detail = herrRaw(raw);
  if (/invalid reference:\s*HEAD|not a valid object name:?\s*'?HEAD|ambiguous argument '?HEAD|does not have any commits|unknown revision[^\n]*HEAD/i.test(detail)) {
    return {text: 'This folder has no commits yet. Make a first commit, then try again.', hint: '', detail};
  }
  if (/not a git repository/i.test(detail)) return {text: "This folder isn't a git repository.", hint: '', detail};
  if (herrIsPermission(detail)) return {text: "Atomic Agent can't write to this folder.", hint: '', detail};
  return {text: "Couldn't make a worker copy of this folder.", hint: '', detail};
}

/** The Details disclosure alone; '' when there is nothing more to say than `text`. */
function herrDetailsHTML(detail, text) {
  const d = herrRaw(detail);
  if (!d || d === String(text || '').trim()) return '';
  return '<details class="herr-det"><summary>Details</summary><pre class="herr-raw">' + herrEsc(d) + '</pre></details>';
}

/** The sentence, the hint and Details, for inside a notice or a help line. */
function herrBodyHTML(e) {
  const err = herrOf(e);
  if (!err.text) return '';
  return '<span class="herr-t">' + herrEsc(err.text) + '</span>'
    + (err.hint ? '<span class="herr-hint">' + herrEsc(err.hint) + '</span>' : '')
    + herrDetailsHTML(err.detail, err.text);
}

/** A red notice. `o`: {icon, cls, extra}; icon and extra are trusted HTML (an ic() svg, buttons). */
function herrNoticeHTML(e, o) {
  const body = herrBodyHTML(e);
  if (!body) return '';
  const opts = o || {};
  return '<div class="tk-notice tk-notice--red herr' + (opts.cls ? ' ' + opts.cls : '') + '" role="alert">' + (opts.icon || '')
    + '<span class="grow">' + body + '</span>' + (opts.extra || '') + '</div>';
}

if (typeof module !== 'undefined') module.exports = {
  herrEsc, herrRaw, herrCode, herrIsPermission, herrBase, herrHuman, herrSentence, herrOf, herrFsRead, herrGitWorktree,
  herrDetailsHTML, herrBodyHTML, herrNoticeHTML,
};
