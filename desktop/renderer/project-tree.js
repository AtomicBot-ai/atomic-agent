/* ---------------- ATO-2445: the project tree in the Files panel ----------------
   Loaded after file-preview.js, whose list view (the toolbar's Files button,
   ⌥⌘F) it draws into: fpListHtml hands it the chat's own list and
   fpPaintHead asks it for the title. Over the list, a switch: "This chat"
   (the chat's files, as before) or "Project", the tree of the chat's
   working folder, the folder @-mentions list.

   main reads one folder at a time when it is opened (files:tree,
   main/project-tree.ts): its entries without what .gitignore leaves out (or
   the mention walk's skipped folders outside a checkout), each changed file
   with its git mark (M, A, R, U, C) and a dot on folders with changes
   inside. A file clicked opens in the preview as one picked from the list
   (its Open and Reveal through main's preview check); the tabs' list button
   comes back to the tree, still open where it was. Another chat starts
   again from its own folder. Loading, error and empty states for the root
   and for every folder.

   Precedent: Kilo Desktop's files tab, VS Code's Explorer with git
   decorations, Cursor's file tree.

   Its buttons are [data-ptx] (file-preview.js takes [data-fp] clicks).

   Shared with the Node checks (test/project-tree.test.mjs): ptListHtml,
   ptRowsHtml, ptJoin, PT. */

const PT = {mode: 'chat', sid: undefined, root: '', name: '', git: false, nodes: new Map(), open: new Set(), seq: 0};
const PT_MARK_TITLE = {M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', U: 'Untracked', C: 'Conflict'};

function ptSid() { return typeof S !== 'undefined' && S ? (S.sessionId || S.agentSession || null) : null; }
function ptIcon(n) { return typeof fpIcon === 'function' ? fpIcon(n) : ''; }

/** The real path of `rel` under the tree's root, on the root's own separators. */
function ptJoin(root, rel) {
  const sep = /\\/.test(root) && !/\//.test(root) ? '\\' : '/';
  const base = root.endsWith(sep) ? root : root + sep;
  return rel ? base + rel.split('/').join(sep) : root;
}

/** Another chat on screen: its own tree, from the top. */
function ptSyncChat() {
  const sid = ptSid();
  if (PT.sid === sid) return;
  PT.sid = sid; PT.root = ''; PT.name = ''; PT.git = false; PT.nodes = new Map(); PT.open = new Set(); PT.seq++;
}

/** Asks main for folder `rel` once; repaints the list when it answers. */
function ptLoad(rel) {
  const br = typeof fpBridge === 'function' ? fpBridge() : null;
  const n = PT.nodes.get(rel);
  if (n && n.state !== 'error') return;
  PT.nodes.set(rel, {state: 'loading'});
  if (!br || typeof br.filesTree !== 'function') { PT.nodes.set(rel, {state: 'error', reason: 'failed'}); return; }
  const seq = PT.seq;
  Promise.resolve().then(() => br.filesTree(PT.sid, rel)).then((r) => r, () => null).then((r) => {
    if (seq !== PT.seq) return;   // another chat, or Reload, meanwhile
    if (r && r.ok) {
      PT.nodes.set(rel, {state: 'ok', entries: Array.isArray(r.entries) ? r.entries : [], cut: !!r.cut});
      if (!rel) { PT.root = String(r.root || ''); PT.name = String(r.name || ''); PT.git = !!r.git; }
    } else {
      PT.nodes.set(rel, {state: 'error', reason: (r && r.reason) || 'failed'});
    }
    ptRepaint();
  });
}

function ptRepaint() {
  if (typeof FP === 'undefined' || !FP.open || FP.path || PT.mode !== 'tree' || typeof fpEl !== 'function') return;
  const body = fpEl() && fpEl().querySelector('.fp-body');
  const top = body ? body.scrollTop : 0;
  if (typeof fpPaintHead === 'function') fpPaintHead();
  if (typeof fpPaintBody === 'function') fpPaintBody(fpListHtml());
  const after = fpEl() && fpEl().querySelector('.fp-body');
  if (after) after.scrollTop = top;
}

function ptWhy(reason) {
  return reason === 'remote' ? 'This chat’s folder is on another computer.'
    : reason === 'no-folder' ? 'This chat has no working folder yet.'
    : reason === 'outside' ? 'This folder is outside the folders the preview can read.'
    : reason === 'missing' || reason === 'not-dir' ? 'The folder is no longer there.'
    : 'The folder could not be read.';
}

/** The rows of folder `rel` at `depth`, its open subfolders under them. */
function ptRowsHtml(rel, depth) {
  const node = PT.nodes.get(rel);
  const pad = 'padding-left:' + (8 + depth * 14) + 'px';
  if (!node || node.state === 'loading') return '<li class="pt-msg" style="' + pad + '">Loading…</li>';
  if (node.state === 'error') return '<li class="pt-msg" style="' + pad + '">' + fpEsc(ptWhy(node.reason)) + '</li>';
  if (!node.entries.length) return '<li class="pt-msg" style="' + pad + '">' + (rel ? 'Empty folder' : 'This folder is empty.') + '</li>';
  return node.entries.map((e) => {
    const open = e.dir && PT.open.has(e.rel);
    const mark = !e.dir && e.mark && PT_MARK_TITLE[e.mark] ? '<span class="pt-mark pt-m-' + e.mark + '" title="' + PT_MARK_TITLE[e.mark] + '">' + e.mark + '</span>'
      : e.changed ? '<span class="pt-dot" title="Has changes"></span>' : '';
    return '<li><button class="pt-row' + (e.mark ? ' pt-has-' + e.mark : '') + '" data-ptx="' + (e.dir ? 'toggle' : 'open') + '" data-pt-rel="' + fpEsc(e.rel) + '"'
      + (e.dir ? ' aria-expanded="' + open + '"' : '') + ' title="' + fpEsc(e.rel) + '" style="' + pad + '">'
      + '<span class="pt-chev">' + (e.dir ? ptIcon(open ? 'chevD' : 'chevR') : '') + '</span>'
      + '<span class="pt-ic">' + ptIcon(e.dir ? 'folder' : 'doc') + '</span>'
      + '<span class="pt-n">' + fpEsc(e.name) + '</span>' + mark + '</button></li>'
      + (open ? ptRowsHtml(e.rel, depth + 1) : '');
  }).join('') + (node.cut ? '<li class="pt-msg" style="' + pad + '">Showing the first ' + node.entries.length + (node.entries.length === 1 ? ' item' : ' items') + ' of this folder.</li>' : '');
}

/** The list view's body: the switch, then the chat's list (`chatHtml`) or the tree. */
function ptListHtml(chatHtml) {
  ptSyncChat();
  const tab = (mode, label) => '<button class="pt-tab' + (PT.mode === mode ? ' on' : '') + '" role="tab" aria-selected="' + (PT.mode === mode)
    + '" data-ptx="mode" data-pt-mode="' + mode + '">' + label + '</button>';
  const bar = '<div class="pt-switch" role="tablist">' + tab('chat', 'This chat') + tab('tree', 'Project')
    + (PT.mode === 'tree' ? '<button class="fp-btn pt-reload" data-ptx="reload" title="Read the folder again" aria-label="Read the folder again">↻</button>' : '') + '</div>';
  if (PT.mode !== 'tree') return bar + chatHtml;
  if (!PT.nodes.has('')) ptLoad('');
  return bar + '<ul class="pt-tree" role="tree">' + ptRowsHtml('', 0) + '</ul>';
}

/** The head's title in the tree: the folder's name, and whether it is a git checkout. */
function ptHead() {
  if (PT.mode !== 'tree') return null;
  ptSyncChat();
  return {name: PT.name || 'Project', meta: PT.root ? (PT.git ? 'Git checkout' : 'Folder') : ''};
}

function ptClick(b) {
  const what = b.dataset.ptx;
  const rel = b.dataset.ptRel || '';
  if (what === 'mode') { PT.mode = b.dataset.ptMode === 'tree' ? 'tree' : 'chat'; ptRepaintAny(); return; }
  if (what === 'reload') { PT.nodes = new Map(); PT.seq++; ptRepaintAny(); for (const r of PT.open) ptLoad(r); return; }
  if (what === 'toggle') {
    if (PT.open.has(rel)) PT.open.delete(rel); else { PT.open.add(rel); ptLoad(rel); }
    ptRepaint();
    return;
  }
  if (what === 'open' && PT.root && typeof filePreviewOpen === 'function') filePreviewOpen(ptJoin(PT.root, rel), {listed: true});
}
function ptRepaintAny() {
  if (typeof FP === 'undefined' || !FP.open || FP.path) return;
  if (typeof fpPaintHead === 'function') fpPaintHead();
  if (typeof fpPaintBody === 'function') fpPaintBody(fpListHtml());
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('#fpreview [data-ptx]') : null;
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    ptClick(b);
  }, true);
}

if (typeof module !== 'undefined') module.exports = {ptListHtml, ptRowsHtml, ptJoin, ptHead, PT};
