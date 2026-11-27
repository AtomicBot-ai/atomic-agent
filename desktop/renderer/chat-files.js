/* ---------------- ATO-1256: this chat's files, beside the chat ----------------
   Loaded before file-preview.js and renderer.js. The toolbar's Files button
   and View › Toggle Chat Files (⌥⌘F, Ctrl+Shift+F off macOS) open the preview
   panel (file-preview.js) at any time, not only from a file chip. Its top row
   lists the files of the chat on screen, newest first; a click shows one with
   the #953 preview, and "All files" goes back to the list.

   The list is read from the transcript, so it follows the chat as it goes on,
   belongs to that chat alone, and is the same when the chat is opened again
   (the transcript comes back from the agent's store):
   - your attachments (the `[attachments]` block of a message, attachments.js);
   - the files a reply delivers (`replyFiles`) and the files a turn wrote
     ("Saved to", `attach`);
   - the files a reply names that main found (the reply's own chips:
     replyPathKnown), never a path main has not confirmed;
   - files the agent wrote (os.fs.write / edit / patch, a call that succeeded),
     the Office files it made or changed (ATO-2409: os.fs.docx, os.fs.xlsx
     except `op: read`, os.fs.write_pptx; the `path` of the call, made
     absolute against the working folder, as the agent resolves it),
     pictures image.generate made, and screenshots (os.screen.capture,
     browser.screenshot: the `saved <path> (` line of their result).
   A path that no longer exists is dropped once main's stat says so.

   ATO-2409: a reply that names one of these files by its bare name in a code
   span (`sales.docx`) gets a chip for it too: renderer.js renderProseFresh asks
   chatFilesByName, which answers with the chat's file of that name (the panel's
   list), and main confirms the path as for any chip. The list changing bumps the
   prose cache and asks for a repaint, so a reply drawn before the write landed
   gets its chips.

   Nothing here reads a file: showing one is file-preview.js's IPC call, and
   main checks the path there (main/file-preview.ts), as it does for a chip.
   Names and paths are only ever written escaped.

   The pure part is exported for test/chat-files.test.mjs. */

const CF_MAX = 200;
const CF_PICTURE = /\.(png|jpe?g|webp|gif)$/i;
const CF_VIDEO = /\.(mp4|webm|m4v)$/i;
/* ATO-2409: the Office writers (src/tools/os/office, src/tools/os/pptx). They send no
   diffstat, so the chat reads their `path` argument; cfOfficeWrite says when a call wrote. */
const CF_OFFICE = new Set(['os.fs.docx', 'os.fs.xlsx', 'os.fs.write_pptx']);
const CF_WRITES = new Set(['os.fs.write', 'os.fs.edit', 'os.fs.patch', ...CF_OFFICE]);
const CF_SHOTS = new Set(['os.screen.capture', 'browser.screenshot']);
/* A reply's path, as renderer.js renderProseFresh finds it (`~/…` or `/…`, a dotted extension). */
const CF_TEXT_PATH = /(?<![\p{L}\p{N}_\/])((?:~\/|\/)(?:[\p{L}\p{N}_.@+-]+\/)*[\p{L}\p{N}_.@+-]+\.[A-Za-z0-9]{1,10})(?![\p{L}\p{N}_\/])/gu;

/** 'image' | 'video' | 'file' by extension. */
function cfKind(path) {
  const p = String(path || '');
  return CF_PICTURE.test(p) ? 'image' : CF_VIDEO.test(p) ? 'video' : 'file';
}

/** The screenshot a capture tool's result names (`saved /tmp/…/screen-….jpg (1280x800 px) …`), or ''. */
function cfShotPath(out) {
  const m = /^saved (\S.*?\.(?:jpe?g|png)) \(/m.exec(String(out || ''));
  return m ? m[1] : '';
}

/** ATO-1258: the pictures a reply's text names (`/tmp/mac-screen.png`, `~/Desktop/shot.jpg`), once each. */
function cfTextPictures(text) {
  const found = [];
  CF_TEXT_PATH.lastIndex = 0;
  let m;
  while ((m = CF_TEXT_PATH.exec(String(text || '')))) if (CF_PICTURE.test(m[1]) && !found.includes(m[1])) found.push(m[1]);
  return found;
}

/**
 * ATO-1258: the pictures a reply shows beyond its own files (`replyFiles`):
 * the pictures its text names, and the turn's last screenshot
 * (os.screen.capture, browser.screenshot) when the reply shows no picture of
 * its own. Map reply id → paths. Each screenshot of the turn is also under
 * its own card (renderer.js toolCard) and in the chat's files.
 */
function turnPictures(log) {
  const out = new Map();
  let shot = '';
  for (const m of Array.isArray(log) ? log : []) {
    if (!m) continue;
    if (m.k === 'user' && !m.steered) { shot = ''; continue; }
    if (m.k === 'tool' && CF_SHOTS.has(m.name) && m.ok === true && m.outcome == null) { shot = cfShotPath(m.out) || shot; continue; }
    if (m.k !== 'assistant' || m.placeholder) continue;
    const own = Array.isArray(m.replyFiles) ? m.replyFiles : [];
    const named = cfTextPictures(m.text).filter((p) => !own.includes(p));
    const pics = named.slice();
    if (shot && !own.includes(shot) && !named.includes(shot) && !own.some((p) => CF_PICTURE.test(p)) && !named.length) pics.push(shot);
    if (pics.length) out.set(m.id, pics);
    shot = '';
  }
  return out;
}

/** The pictures image.generate's result lists (`- /path/to/x.png`). */
function cfGeneratedPaths(out) {
  const found = [];
  const re = /^- ((?:~|\/|[A-Za-z]:[\\/]).*\.(?:png|jpe?g|webp|gif))\s*$/gim;
  let m;
  while ((m = re.exec(String(out || '')))) found.push(m[1]);
  return found;
}

/**
 * ATO-2409: what an Office writer's call wrote: `{path, created}` from its
 * arguments (the path as the model gave it; `created` for `op: create` and a
 * deck, which os.fs.write_pptx always makes anew), or null when the call is
 * not an Office writer, read a workbook (`os.fs.xlsx op: read`) or named no path.
 */
function cfOfficeWrite(name, args) {
  if (!CF_OFFICE.has(name)) return null;
  const a = args && typeof args === 'object' ? args : {};
  const op = typeof a.op === 'string' ? a.op : '';
  if (name === 'os.fs.xlsx' && op === 'read') return null;
  const path = typeof a.path === 'string' ? a.path.trim() : '';
  if (!path) return null;
  return {path, created: name === 'os.fs.write_pptx' || op === 'create'};
}

/**
 * ATO-2409: the chat's file a reply names by its bare name in a code span
 * (`sales.docx`): the newest file of that exact name among `files` (the
 * panel's list, CF.files by default), or '' when none or when `raw` is not a
 * bare file name (a path, a folder, no extension, anything a chip cannot carry).
 */
function chatFilesByName(raw, files) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s || s.length > 255 || /[\\/\0\n<>"]/.test(s) || !/^[^.\s].*\.[A-Za-z0-9]{1,10}$/.test(s)) return '';
  const list = Array.isArray(files) ? files : CF.files;
  const hit = list.find((f) => f && f.name === s && typeof f.path === 'string');
  return hit ? hit.path : '';
}

/** A tool argument's path, made absolute against the working folder and home. */
function cfAbsolute(p, wd, home) {
  const s = String(p == null ? '' : p).trim();
  if (!s || /[\0\n]/.test(s) || /^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return '';
  if (s === '~' || s.startsWith('~/')) return home ? home + s.slice(1) : '';
  if (s.startsWith('/') || /^[A-Za-z]:[\\/]/.test(s)) return s;
  if (!wd) return '';
  return String(wd).replace(/[\\/]+$/, '') + '/' + s.replace(/^\.\//, '');
}

/**
 * The files of a transcript, newest first, once each:
 * [{path, name, kind: 'image'|'video'|'file', from: 'you'|'reply'|'agent'|'image'|'shot'}].
 * deps: {workingDir, home, argsOf(card) → object, split(text) → attSplitMessage's answer,
 *        replyPath(raw) → main's verdict {ok, abs, kind} or null while unknown,
 *        missing: Set of paths main said are gone}.
 */
function chatFilesOf(log, deps) {
  const d = deps || {};
  const seen = new Map();
  const add = (path, from) => {
    const p = String(path || '');
    if (!p || p.length > 4096 || /[\0\n]/.test(p) || (d.missing && d.missing.has(p))) return;
    if (seen.has(p)) seen.delete(p);   // named again: it moves up to now
    seen.set(p, {path: p, name: p.split(/[\\/]/).pop() || p, kind: cfKind(p), from});
  };
  for (const m of Array.isArray(log) ? log : []) {
    if (!m || typeof m !== 'object') continue;
    if (m.k === 'user' && typeof d.split === 'function') {
      const split = d.split(m.text);
      if (split && Array.isArray(split.items)) split.items.forEach((i) => { if (i && !i.failed && i.path) add(i.path, 'you'); });
      continue;
    }
    if (m.k === 'tool' && m.ok === true && m.outcome == null) {
      if (CF_WRITES.has(m.name) && typeof d.argsOf === 'function') {
        const a = d.argsOf(m) || {};
        // ATO-2409: an Office writer's call counts when it wrote (never `os.fs.xlsx op: read`).
        const w = CF_OFFICE.has(m.name) ? cfOfficeWrite(m.name, a) : {path: a.path};
        if (w) add(cfAbsolute(w.path, d.workingDir, d.home), 'agent');
      } else if (m.name === 'image.generate') {
        cfGeneratedPaths(m.out).forEach((p) => add(cfAbsolute(p, '', d.home), 'image'));
      } else if (CF_SHOTS.has(m.name)) {
        add(cfShotPath(m.out), 'shot');
      }
      continue;
    }
    if (m.k === 'assistant' && !m.placeholder) {
      if (typeof d.replyPath === 'function') {
        const text = String(m.text || '');
        CF_TEXT_PATH.lastIndex = 0;
        let mt;
        while ((mt = CF_TEXT_PATH.exec(text))) {
          const v = d.replyPath(mt[1]);
          if (v && v.ok && v.abs && v.kind === 'file') add(v.abs, 'reply');
        }
      }
      // ATO-1258: a picture the reply's text names (main's stat drops it if it is not there).
      cfTextPictures(m.text).forEach((p) => add(cfAbsolute(p, '', d.home), 'reply'));
      (Array.isArray(m.attach) ? m.attach : []).forEach((f) => { if (f && f.kind !== 'dir') add(f.path, 'agent'); });
      (Array.isArray(m.replyFiles) ? m.replyFiles : []).forEach((p) => add(p, 'reply'));
    }
  }
  return Array.from(seen.values()).reverse().slice(0, CF_MAX);
}

/** What the list says a file is. */
function cfFromLabel(f) {
  return f.from === 'you' ? 'Attached by you' : f.from === 'shot' ? 'Screenshot' : f.from === 'image' ? 'Generated picture'
    : f.from === 'agent' ? 'Written by the agent' : 'From a reply';
}

/** Where the file is, short: the folder with ~ for home. */
function cfFolder(path, home) {
  const p = String(path || '');
  const at = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  let dir = at > 0 ? p.slice(0, at) : '';
  if (home && (dir === home || dir.startsWith(home + '/') || dir.startsWith(home + '\\'))) dir = '~' + dir.slice(home.length);
  return dir.length > 60 ? '…' + dir.slice(-59) : dir;
}

/* ---------- the panel's list (file-preview.js draws it) ---------- */

/** The tab row over a previewed file: "All files", then each file. html. deps: {esc, icon}. */
function chatFilesTabsHTML(files, active, deps) {
  const {esc, icon} = deps;
  if (!files.length) return '';
  return '<div class="fp-tabs" role="tablist" aria-label="Files in this chat">'
    + '<button class="fp-tab fp-tab-all" role="tab" aria-selected="false" data-fp="list" title="All files in this chat">'
      + icon('files') + '<span>All files</span><span class="fp-tab-n tnum">' + files.length + '</span></button>'
    + files.map((f) => '<button class="fp-tab' + (f.path === active ? ' on' : '') + '" role="tab" aria-selected="' + (f.path === active) + '"'
      + ' data-fp="pick" data-fp-path="' + esc(f.path) + '" title="' + esc(f.path) + '">'
      + icon(f.kind === 'image' ? 'image' : f.kind === 'video' ? 'play' : 'doc') + '<span>' + esc(f.name) + '</span></button>').join('')
    + '</div>';
}

/** The panel's body when no file is picked: the list, or what will appear in it. html. deps: {esc, icon, home}. */
function chatFilesListHTML(files, deps) {
  const {esc, icon, home} = deps;
  if (!files.length) {
    return '<div class="fp-empty"><div class="fp-other-ic">' + icon('files') + '</div>'
      + '<div class="fp-other-n">No files in this chat yet</div>'
      + '<div class="fp-other-m">Files the agent makes or mentions, your attachments, generated pictures and screenshots appear here.</div></div>';
  }
  return '<ul class="fp-list" role="list">' + files.map((f) => '<li><button class="fp-row" data-fp="pick" data-fp-path="' + esc(f.path) + '" title="' + esc(f.path) + '">'
      + '<span class="fp-row-ic">' + icon(f.kind === 'image' ? 'image' : f.kind === 'video' ? 'play' : 'doc') + '</span>'
      + '<span class="fp-row-t"><span class="fp-row-n">' + esc(f.name) + '</span>'
      + '<span class="fp-row-m">' + esc(cfFromLabel(f)) + (cfFolder(f.path, home) ? ' · ' + esc(cfFolder(f.path, home)) : '') + '</span></span>'
    + '</button></li>').join('') + '</ul>';
}

/* ---------- following the chat on screen (renderer.js calls chatFilesSync from render()) ---------- */

/* stat: paths already looked at; missing: the ones main said are gone. */
const CF = {sid: null, sig: '', files: [], missing: new Set(), stat: new Set(), statTimer: 0};

/** The open chat's files, from renderer.js's state. */
function chatFilesNow() {
  if (typeof S === 'undefined' || !S || S.room !== 'chat') return [];
  return chatFilesOf(S.log, {
    workingDir: typeof workingDir === 'function' ? workingDir() : '',
    home: typeof homeDir === 'function' ? homeDir() : '',
    argsOf: (m) => (typeof toolArgsObj === 'function' ? toolArgsObj(m.args || m.arg) : {}),
    split: typeof attSplitMessage === 'function' ? attSplitMessage : null,
    replyPath: typeof replyPathKnown === 'function' ? replyPathKnown : null,
    missing: CF.missing,
  });
}

/** Once per paint: a new chat, or a changed list, reaches the panel. */
function chatFilesSync() {
  if (typeof S === 'undefined' || !S) return;
  const sid = S.room === 'chat' ? String(S.sessionId || '') : null;
  // A new chat's stand-in id ('' or `waiting-…`) turning into the agent's own is the same chat.
  const chatChanged = sid !== CF.sid && !(CF.sid === '' || String(CF.sid || '').startsWith('waiting-'));
  // Another chat: paths are looked at again, so a file made since (or made again) is listed.
  if (chatChanged) { CF.stat.clear(); CF.missing.clear(); }
  const files = chatFilesNow();
  const sig = files.map((f) => f.path).join('\n');
  if (!chatChanged && sig === CF.sig) return;
  CF.sid = sid; CF.sig = sig; CF.files = files;
  cfStatSoon();
  /* ATO-2409: a reply's bare `sales.docx` is a chip only once the file is on
     this list, and finished markup is cached (renderer.js PROSE_CACHE), so a
     changed list retires that cache and asks for one transcript repaint. */
  if (files.length && typeof PROSE_CACHE !== 'undefined' && PROSE_CACHE) {
    PROSE_CACHE.ver++;
    if (typeof streamPaint === 'function') streamPaint('chat');
  }
  if (typeof filePreviewFilesChanged === 'function') filePreviewFilesChanged(files, chatChanged, sid === null);
}

/* Each path is stat'ed once (main's app:statPaths: exists or not, nothing read); a gone one leaves the list. */
function cfStatSoon() {
  const br = typeof window !== 'undefined' ? window.atomic : null;
  if (!br || !br.statPaths || CF.statTimer) return;
  CF.statTimer = setTimeout(async () => {
    CF.statTimer = 0;
    const ask = CF.files.map((f) => f.path).filter((p) => !CF.stat.has(p));
    ask.forEach((p) => CF.stat.add(p));
    let gone = false;
    for (let i = 0; i < ask.length; i += 64) {
      let r = null;
      try { r = await br.statPaths(ask.slice(i, i + 64)); } catch (e) { r = null; }
      (r && r.ok && Array.isArray(r.files) ? r.files : []).forEach((f) => {
        if (f && f.exists === false && typeof f.path === 'string') { CF.missing.add(f.path); gone = true; }
      });
    }
    if (gone) { CF.sig = ''; chatFilesSync(); }
  }, 300);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {chatFilesOf, cfShotPath, cfTextPictures, turnPictures, CF_SHOTS, CF_OFFICE, cfOfficeWrite, chatFilesByName, cfGeneratedPaths, cfAbsolute, cfKind, cfFolder, chatFilesTabsHTML, chatFilesListHTML};
}
