/* ---------------- ATO-1187: "Changed files" under a reply, and the Results tab ----------------
   Loaded before renderer.js; declares only. Shared by the renderer and the
   Node checks (test/changed-files.test.mjs).

   A reply that wrote files said "Saved to …" with a chip per file, and
   nothing about how much each one changed. An agent with ATO-1187 puts
   `diffstat: {path, added, removed}` on the `tool_result` frame of an ok
   os.fs.write / os.fs.edit. The turn's reply collects them (one row per
   file, counts summed over its writes and edits) and draws a card under
   its text, "Changed files (2)" with +12 −3 per file. The side panel's
   Results tab lists every file of the latest turn: the changed ones with
   their counts, then the files the reply delivered or names as saved.

   An older agent sends no `diffstat`: no card, and the Results tab lists
   the reply's files without counts. The session store keeps no tool
   details, so a reopened chat has no counts either. Rows are .filechip
   buttons with an absolute `data-file`, so the window's click (preview or
   open) and context menu work on them unchanged. */

const CHANGED_FILES_MAX = 50;

/** A frame's `diffstat`, checked: `{path, added, removed}` or null. */
function changedFileOfFrame(p) {
  const d = p && typeof p === 'object' ? p.diffstat : null;
  if (!d || typeof d !== 'object') return null;
  const count = (n) => typeof n === 'number' && Number.isInteger(n) && n >= 0;
  if (typeof d.path !== 'string' || !d.path || !count(d.added) || !count(d.removed)) return null;
  return {path: d.path, added: d.added, removed: d.removed};
}

/** The list with one more change: a file already on it adds its counts, a new one goes last. */
function changedFilesAdd(list, entry) {
  const out = Array.isArray(list) ? list.slice() : [];
  if (!entry) return out;
  const i = out.findIndex((f) => f.path === entry.path);
  if (i >= 0) {
    const f = out[i];
    out[i] = {path: f.path, added: f.added + entry.added, removed: f.removed + entry.removed, edits: (f.edits || 1) + 1};
  } else if (out.length < CHANGED_FILES_MAX) {
    out.push({path: entry.path, added: entry.added, removed: entry.removed, edits: 1});
  }
  return out;
}

function changedFilesBase(path) {
  const s = String(path || '').replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

/** "+12 −3" for one file; a side that is zero is left out, a file with neither says "no line changes". */
function changedFilesCountsHTML(f, esc) {
  const parts = [];
  if (f.added) parts.push('<span class="cf-add">+' + esc(String(f.added)) + '</span>');
  if (f.removed) parts.push('<span class="cf-del">−' + esc(String(f.removed)) + '</span>');
  return parts.length ? parts.join(' ') : '<span class="cf-none">no line changes</span>';
}

function changedFilesRowHTML(f, deps) {
  const {esc, ic} = deps;
  const name = changedFilesBase(f.path) || f.path;
  const counts = typeof f.added === 'number' ? '<span class="cf-counts mono">' + changedFilesCountsHTML(f, esc) + '</span>' : '';
  return '<button class="filechip cf-row" data-file="' + esc(f.path) + '" title="' + esc(f.path) + '">'
    + (ic ? ic('doc') : '') + '<span class="cf-name">' + esc(name) + '</span>' + counts + '</button>';
}

/** The card under a reply: '' when the turn changed no file this window heard of. */
function changedFilesCardHTML(list, deps) {
  const files = Array.isArray(list) ? list : [];
  if (!files.length) return '';
  return '<div class="cf-card" data-changed-files="' + files.length + '">'
    + '<div class="cf-head">Changed files (' + files.length + ')</div>'
    + '<div class="cf-list">' + files.map((f) => changedFilesRowHTML(f, deps)).join('') + '</div></div>';
}

/** The paths the card already shows, for the "Saved to" strip to leave out. */
function changedFilesPaths(list) {
  return Array.isArray(list) ? list.map((f) => f.path) : [];
}

/** Every file of one reply's turn: changed ones (with counts) first, then delivered and saved ones, once each. */
function turnResultFiles(m) {
  if (!m) return [];
  const out = Array.isArray(m.changed) ? m.changed.slice() : [];
  const seen = new Set(out.map((f) => f.path));
  const more = [];
  for (const p of Array.isArray(m.replyFiles) ? m.replyFiles : []) if (typeof p === 'string') more.push(p);
  for (const f of Array.isArray(m.attach) ? m.attach : []) if (f && typeof f.path === 'string' && f.kind !== 'dir') more.push(f.path);
  for (const p of more) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push({path: p});
  }
  return out;
}

/** The latest reply in the transcript: the turn the Results tab is about. */
function latestReply(log) {
  if (!Array.isArray(log)) return null;
  for (let i = log.length - 1; i >= 0; i--) if (log[i] && log[i].k === 'assistant') return log[i];
  return null;
}

/** The side panel's Results tab body. */
function resultsPaneHTML(log, deps) {
  const files = turnResultFiles(latestReply(log));
  if (!files.length) return '<p class="cap">Files the agent changes or saves in this turn appear here.</p>';
  const changed = files.filter((f) => typeof f.added === 'number').length;
  return '<div class="cf-pane"><div class="insp-lbl">'
    + (changed ? 'Changed files (' + changed + ')' : 'Files') + (files.length > changed && changed ? ' · ' + (files.length - changed) + ' more' : '')
    + '</div><div class="cf-list">' + files.map((f) => changedFilesRowHTML(f, deps)).join('') + '</div></div>';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {CHANGED_FILES_MAX, changedFileOfFrame, changedFilesAdd, changedFilesBase, changedFilesCardHTML, changedFilesPaths, turnResultFiles, latestReply, resultsPaneHTML};
}
