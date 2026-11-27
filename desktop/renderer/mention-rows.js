/* ATO-2751: the `@` words that are not plain files, offered as rows of the
   composer's `@` menu (file-mentions.js), and the plain reason a mention was
   skipped, for the line under a sent message.

   main/mention-kinds.ts is what reads these words when the message goes out
   (`@diff`, `@git:N`, `@path:10-40`, `@folder/`, `@https://...`) and it
   already puts them above the files it finds. The renderer offers them too,
   from the typed text alone, so the row is there before the file search
   answers and when the search fails. The precedent: Cursor's `@` menu lists
   Git and Web next to the files, and Claude Code's `@` menu completes what
   was typed.

   Loaded before file-mentions.js; the Node checks load it as is
   (test/file-mentions-renderer.test.mjs). */

const MR_GIT_MAX = 20;   // main/mention-kinds.ts MAX_GIT_COMMITS
const MR_WORDS = ['diff', 'git:5'];
const MR_GIT = /^git:(\d{1,4})$/i;
const MR_RANGE = /^(.+?)(?::(\d{1,7})(?:-(\d{1,7}))?|#L(\d{1,7})(?:-L?(\d{1,7}))?)$/;

/** A typed http(s) link with a host, as main reads it; null otherwise. */
function mrUrl(q) {
  if (!/^https?:\/\/[^\s/]/i.test(q)) return null;
  try {
    const u = new URL(q);
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return null;
    return q;
  } catch (err) {
    return null;
  }
}

/** A typed line range: {path, start, end}, or null. */
function mrRange(q) {
  if (/^https?:/i.test(q)) return null;
  const m = MR_RANGE.exec(q);
  if (!m || !m[1]) return null;
  const start = Number(m[2] || m[4]);
  const end = (m[3] || m[5]) !== undefined ? Number(m[3] || m[5]) : start;
  if (!(start >= 1) || end < start) return null;
  return {path: m[1], start, end};
}

/** The rows the menu puts above the files for `query` (what follows the `@`). */
function mrKindRows(query) {
  const q = String(query == null ? '' : query).trim();
  if (!q) return [];
  const git = MR_GIT.exec(q);
  if (git) {
    const n = Number(git[1]);
    return n >= 1 ? ['git:' + Math.min(n, MR_GIT_MAX)] : [];
  }
  if (mrUrl(q)) return [q];
  if (mrRange(q)) return [q];
  if (q.length > 1 && q.endsWith('/')) return [q];
  const low = q.toLowerCase();
  return MR_WORDS.filter((w) => w.startsWith(low));
}

/** What a row reads: 'Uncommitted changes', 'The last 5 commits', 'Web page', 'Lines 10 to 40', 'Folder', or ''. */
function mrRowHint(row) {
  const r = String(row == null ? '' : row);
  if (r === 'diff') return 'Uncommitted changes';
  const git = MR_GIT.exec(r);
  if (git) return Number(git[1]) === 1 ? 'The last commit' : 'The last ' + git[1] + ' commits';
  if (mrUrl(r)) return 'Web page';
  const range = mrRange(r);
  if (range) return range.start === range.end ? 'Line ' + range.start : 'Lines ' + range.start + ' to ' + range.end;
  if (r.length > 1 && r.endsWith('/')) return 'Folder';
  return '';
}

/** The kind rows first, then the files main found, each once, at most `max`. */
function mrMerge(kinds, paths, max) {
  const out = [];
  for (const p of [].concat(kinds || [], paths || [])) {
    if (typeof p === 'string' && p && !out.includes(p)) out.push(p);
  }
  return out.slice(0, max || 50);
}

/**
 * The reason main wrote after `not inlined: ` (main/file-mentions.ts,
 * context-mentions.ts, mention-url.ts), in words for the line under the
 * bubble. The model still reads main's own text; only the chat line changes.
 * An HTTP status is said in words, never as a code.
 */
function mrSkipReason(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return 'skipped';
  const http = /^HTTP (\d{3})$/.exec(s);
  if (http) {
    const code = Number(http[1]);
    if (code === 404 || code === 410) return 'page not found';
    if (code === 401 || code === 403) return 'the page needs a sign-in';
    if (code >= 500) return 'the site had a problem';
    return 'the page could not be read';
  }
  if (/^not a text page\b/.test(s)) return 'not a text page';
  if (/^no answer in\b/.test(s)) return 'the site did not answer';
  return s;
}

if (typeof module !== 'undefined') {
  module.exports = {mrKindRows, mrRowHint, mrMerge, mrSkipReason, mrUrl, mrRange};
}
