/* ATO-563: a unified diff as coloured lines (steps 0 and 1 of the review plan).
   The agent already sends the diff: an os.fs.edit approval's Preview and the
   edit card's result are `--- a/<path>` / `+++ b/<path>` then ` `, `-`, `+`
   lines (src/tools/os/fs/fs-edit-diff.ts), a patch's argument is a git-style
   diff. This file only reads that text; nothing in it touches the DOM, and
   every line goes through the caller's `esc` before it is put in HTML.
   The terminal's twin is src/tui/diff-line-tone.ts. */

/** Is this text a unified diff? A header pair or a hunk line, plus a + or - line.
    Plain content (a Markdown list starts with `- `) is not one. */
function looksLikeUnifiedDiff(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  let header = false, change = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('--- ') && (lines[i + 1] || '').startsWith('+++ ')) { header = true; i++; continue; }
    if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(l)) header = true;
    else if (/^[+-]/.test(l)) change = true;
  }
  return header && change;
}

/** One line's kind: file (the ---/+++ pair), hunk, add, del, ctx, or note
    (anything else the result carries: the agent's own warning lines, `\ No
    newline`, `… [diff truncated]`). */
function diffLineKind(line, next) {
  const l = String(line);
  if (l.startsWith('+++ ')) return 'file';
  if (l.startsWith('--- ') && String(next || '').startsWith('+++ ')) return 'file';
  if (/^@@ /.test(l)) return 'hunk';
  if (/^(?:diff --git |index [0-9a-f]+\.\.|new file mode |deleted file mode |similarity index |rename (?:from|to) )/.test(l)) return 'file';
  if (l.startsWith('+')) return 'add';
  if (l.startsWith('-')) return 'del';
  if (l.startsWith(' ') || l === '') return 'ctx';
  return 'note';
}

/** The diff as [{kind, text}], one entry per line, CR dropped, a trailing empty line dropped. */
function parseDiffLines(text) {
  const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((l, i) => ({kind: diffLineKind(l, lines[i + 1]), text: l}));
}

/** Added and removed lines, for a "+3 −1" count. */
function diffCounts(text) {
  let add = 0, del = 0;
  for (const l of parseDiffLines(text)) { if (l.kind === 'add') add++; else if (l.kind === 'del') del++; }
  return {add, del};
}

/** The diff as HTML: one block span per line, its kind a class. `esc` is the
    renderer's escaper, so no text from the agent reaches the page as markup. */
function diffLinesHTML(text, esc) {
  return '<span class="difflines">' + parseDiffLines(text).map((l) =>
    '<span class="dl dl-' + l.kind + '">' + (l.text ? esc(l.text) : ' ') + '</span>').join('') + '</span>';
}

/** The part of a multi-file diff (an os.fs.patch argument) that is about one
    file: the section whose `+++` (or, for a removed file, `---`) path is that
    file. `root` is the folder the patch's paths are relative to (its
    rootDir), so `b/src/x.ts` is `/w/src/x.ts` and no other x.ts; without it
    the path's tail decides. Null when no section names the file. */
function diffSectionFor(text, file, root) {
  const want = String(file || '').replace(/\\/g, '/');
  if (!want) return null;
  const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  // A section starts at `diff --git`, or at a `---`/`+++` pair that is not
  // already the header of the `diff --git` section above it.
  const starts = [];
  let gitHead = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) { starts.push(i); gitHead = true; }
    else if (l.startsWith('--- ') && (lines[i + 1] || '').startsWith('+++ ')) { if (!gitHead) starts.push(i); gitHead = false; i++; }
    else if (/^[ +@-]/.test(l)) gitHead = false;
  }
  const base = root ? String(root).replace(/\\/g, '/').replace(/\/+$/, '') : '';
  const named = (l) => {
    const p = l.slice(4).replace(/\t.*$/, '').trim();
    if (!p || p === '/dev/null') return false;
    const bare = p.replace(/^[ab]\//, '').replace(/^\.\//, '');
    if (want === bare) return true;
    // With the patch's root, exactly that file; without it, by the path's tail.
    return base ? want === base + '/' + bare : want.endsWith('/' + bare);
  };
  for (let s = 0; s < starts.length; s++) {
    const sec = lines.slice(starts[s], s + 1 < starts.length ? starts[s + 1] : lines.length);
    const plus = sec.find((l) => l.startsWith('+++ '));
    const minus = sec.find((l) => l.startsWith('--- '));
    if ((plus && named(plus)) || (minus && named(minus))) {
      while (sec.length && sec[sec.length - 1] === '') sec.pop();
      return sec.join('\n');
    }
  }
  return null;
}

/** Did a write tool's result say the file's previous content was saved?
    fs-replace-guard.ts: "previous content saved", or "the previous content is
    saved — `os.fs.restore …` brings it back". Too large or a failed save say
    otherwise, and an ordinary edit says nothing: then there is nothing to
    revert to. */
function restoreSaved(out) {
  return /\bprevious content (?:is )?saved\b/.test(String(out || ''));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {looksLikeUnifiedDiff, diffLineKind, parseDiffLines, diffCounts, diffLinesHTML, diffSectionFor, restoreSaved};
}
