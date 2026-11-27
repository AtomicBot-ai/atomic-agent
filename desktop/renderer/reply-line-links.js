/* ---------------- ATO-2445: `src/api.py:42` in a reply opens the preview on that line ----------------
   Loaded before renderer.js, whose renderProseFresh calls lineLinksInHtml on
   a reply's text and lineLinkMatch on each code span. A path followed by a
   line, `path:42`, `path:42:7` or `path#L42`, becomes a chip; a click asks
   main where the path is (app:resolveLinePath: absolute, `~/…`, or relative
   to the chat's working folder, else the one file in that folder whose path
   ends so, the shallowest when several do) and opens it in the preview panel on that line
   (file-preview-line.js). Windows paths too: `C:\x\y.ts:10`, `src\y.ts:10`.

   Precedent: VS Code's and Cursor's terminal `file:line` links, and Claude
   Code's clickable `path:line` in its answers.

   The chip is only a promise: nothing is checked until the click, as VS Code
   resolves a terminal link on hover. A path that is not there says so in a
   toast. Text inside a link or a chip is left alone; a bare `name.com:8080`
   is a host and port, not a file.

   Shared with the Node checks (test/reply-line-links.test.mjs):
   lineLinkMatch, lineLinksInHtml, lineLinkChip. */

const LL_SEG = '[\\p{L}\\p{N}_.@+-]';
const LL_EXT = '\\.[A-Za-z][A-Za-z0-9]{0,9}';
const LL_LINE = '(?::(\\d{1,7})(?::(\\d{1,5}))?|#L(\\d{1,7}))';
const LL_HOSTS = new Set(['com', 'org', 'net', 'io', 'dev', 'ai', 'app', 'co', 'me', 'info', 'local', 'localhost', 'internal', 'ru', 'uk', 'de']);

/** The path part: `~/…` or `/…`, a drive letter on Windows, or a relative path (`\` too on Windows). */
function llPathSource(win) {
  const sep = win ? '[\\\\/]' : '\\/';
  const rel = '(?:\\.{1,2}' + sep + ')?(?:' + LL_SEG + '+' + sep + ')*' + LL_SEG + '+' + LL_EXT;
  const abs = '(?:~\\/|\\/)(?:' + LL_SEG + '+\\/)*' + LL_SEG + '+' + LL_EXT;
  const drive = '[A-Za-z]:[\\\\/](?:' + LL_SEG + '+[\\\\/])*' + LL_SEG + '+' + LL_EXT;
  return win ? '(?:' + drive + '|' + abs + '|' + rel + ')' : '(?:' + abs + '|' + rel + ')';
}
const LL_RE_CACHE = {};
function llRegex(win, whole) {
  const key = (win ? 'w' : 'p') + (whole ? '1' : '0');
  if (!LL_RE_CACHE[key]) {
    const core = '(' + llPathSource(win) + ')' + LL_LINE;
    LL_RE_CACHE[key] = whole ? new RegExp('^' + core + '$', 'u')
      : new RegExp('(?<![\\p{L}\\p{N}_\\/\\\\.:@+-])' + core + '(?![\\p{L}\\p{N}_])', 'gu');
  }
  return LL_RE_CACHE[key];
}

/** {path, line, col} from a regex match, or null when it is a host and port or line 0. */
function llFromMatch(m) {
  const path = m[1];
  const line = parseInt(m[2] || m[4] || '', 10);
  const col = m[3] ? parseInt(m[3], 10) : 0;
  if (!(line > 0)) return null;
  if (!/[\\/]/.test(path)) {
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    if (LL_HOSTS.has(ext)) return null;
  }
  return {path, line, col: col > 0 ? col : 0};
}

/** A code span's text that is one `path:line` and nothing else, or null. */
function lineLinkMatch(raw, win) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s || s.length > 1024 || /:\/\//.test(s)) return null;
  const m = llRegex(!!win, true).exec(s);
  return m ? llFromMatch(m) : null;
}

function llEsc(s) { return String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c])); }

/** The chip for `ln`; `shown` is the html it replaces (escaped text, or the code span). */
function lineLinkChip(ln, shown) {
  const icon = typeof ic === 'function' ? ic('doc') : '';
  return '<button class="filechip lnchip" data-lnpath="' + llEsc(ln.path) + '" data-ln="' + ln.line + '"'
    + (ln.col ? ' data-lncol="' + ln.col + '"' : '')
    + ' title="' + llEsc('Open ' + ln.path + ' at line ' + ln.line) + '">' + icon + '<span>' + shown + '</span></button>';
}

/** `html` with every `path:line` in its text (not in a tag, a link or a button) handed to `put(markup)`. */
function lineLinksInHtml(html, win, put) {
  const re = llRegex(!!win, false);
  let inside = 0;   // depth of <a> and <button> around the text
  return String(html).split(/(<[^>]*>)/).map((part) => {
    if (part.startsWith('<')) {
      if (/^<(?:a|button)[\s>]/i.test(part)) inside++;
      else if (/^<\/(?:a|button)\s*>/i.test(part) && inside > 0) inside--;
      return part;
    }
    if (inside || !part) return part;
    re.lastIndex = 0;
    return part.replace(re, (...m) => {
      const ln = llFromMatch(m);
      return ln ? put(lineLinkChip(ln, m[0])) : m[0];
    });
  }).join('');
}

/** A click on such a chip: main finds the file, the panel opens on the line. */
async function lineLinkOpen(el) {
  const br = typeof window !== 'undefined' ? window.atomic : null;
  const path = el.dataset.lnpath || '';
  const line = parseInt(el.dataset.ln || '', 10) || 0;
  const col = parseInt(el.dataset.lncol || '', 10) || 0;
  if (!br || typeof br.resolveLinePath !== 'function' || !path) return;
  const sid = typeof S !== 'undefined' && S ? (S.sessionId || S.agentSession || null) : null;
  let r = null;
  try { r = await br.resolveLinePath(sid, path); } catch (e) { r = null; }
  if (r && r.ok && r.path && typeof filePreviewOpen === 'function' && filePreviewOpen(r.path, {listed: true, line, col})) return;
  if (typeof toast === 'function') {
    toast('File not found', r && r.reason === 'remote' ? 'This chat’s folder is on another computer.' : 'It is not in this chat’s folder.');
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('[data-lnpath]') : null;
    if (!el) return;
    e.preventDefault(); e.stopPropagation();
    lineLinkOpen(el);
  }, true);
}

if (typeof module !== 'undefined') module.exports = {lineLinkMatch, lineLinksInHtml, lineLinkChip, llFromMatch};
