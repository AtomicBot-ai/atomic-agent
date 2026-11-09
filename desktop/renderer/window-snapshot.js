/* ---------------- ATO-532: a snapshot of an app window in the composer ----------------
   The window button beside "+" (and File › Attach App Window…) opens a picker
   of the other apps' open windows: a small picture and the title of each.
   A click takes a larger snapshot of that one window in main
   (main/window-snapshot-ipc.ts) and hands its bytes to attachments.js as a
   File, exactly as a pasted screenshot goes: attAdd → attPrepare → the inbox.
   There is no second attachment path.

   View-only: windows are looked at, never clicked or typed into. Only windows,
   never the whole screen. On macOS without Screen Recording permission the
   picker says where to turn it on instead of showing an empty list.

   Loaded after attachments.js and before renderer.js; reads their globals
   (BR, ATT, attAdd, attCanDrop, toast, esc, ic, $) only when a function runs.
   The picker lives in #window, outside what render() redraws. The pure part
   is exported for the unit suite at the bottom. */

/** state: closed | loading | list | permission | error | capturing */
const WSNAP = {state: 'closed', windows: [], message: '', busyId: null, seq: 0, returnFocus: null};

/* ---------- pure ---------- */

/** Only a picture main drew is put in an <img>: a data: URL of an image. */
function wsnapSafeImage(url) {
  return typeof url === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(url) ? url : null;
}
/**
 * snapshot:windows' answer → what the picker shows:
 * `{state:'list', windows}` | `{state:'permission', message}` | `{state:'error', message}`.
 * An empty list is a list (the picker says there is nothing to attach).
 */
function wsnapListView(res) {
  if (res && res.ok === true && Array.isArray(res.windows)) {
    const windows = res.windows
      .filter((w) => w && typeof w.id === 'string' && typeof w.name === 'string' && wsnapSafeImage(w.thumb))
      .map((w) => ({id: w.id, name: w.name, thumb: w.thumb, icon: wsnapSafeImage(w.icon)}));
    return {state: 'list', windows};
  }
  if (res && res.reason === 'permission') return {state: 'permission', message: String(res.error || '')};
  return {state: 'error', message: String((res && res.error) || 'The list of windows could not be read.')};
}
/**
 * snapshot:capture's answer → `{ok:true, bytes, name, type}` for a File, or
 * `{ok:false, state, message}` for the picker (permission, or an error line
 * over a fresh list when the window went away).
 */
function wsnapCaptureView(res) {
  if (res && res.ok === true && res.bytes && typeof res.name === 'string'
      && (res.mimeType === 'image/png' || res.mimeType === 'image/jpeg')) {
    return {ok: true, bytes: res.bytes, name: res.name, type: res.mimeType};
  }
  if (res && res.reason === 'permission') return {ok: false, state: 'permission', message: String(res.error || '')};
  if (res && res.reason === 'gone') return {ok: false, state: 'relist', message: String(res.error || 'That window is no longer open.')};
  return {ok: false, state: 'error', message: String((res && res.error) || 'The window could not be captured.')};
}

/* ---------- markup ---------- */

function wsnapButtonHTML() {
  return '<button class="attbtn wsnapbtn' + (WSNAP.state !== 'closed' ? ' is-open' : '') + '" data-wsnap-open="1"'
    + ' title="Attach a snapshot of an app window" aria-label="Attach a snapshot of an app window" aria-haspopup="dialog">'
    + ic('appwin') + '</button>';
}
function wsnapBodyHTML() {
  const s = WSNAP.state;
  if (s === 'loading') return '<div class="wsnapnote"><span class="attspin" aria-hidden="true"></span>Looking for open windows…</div>';
  if (s === 'permission') {
    return '<div class="wsnapnote is-perm">' + ic('lock') + '<p>' + esc(WSNAP.message) + '</p></div>';
  }
  if (s === 'error') return '<div class="wsnapnote is-err">' + ic('alert') + '<p>' + esc(WSNAP.message) + '</p></div>';
  const line = WSNAP.message ? '<div class="wsnapline">' + ic('alert') + '<span>' + esc(WSNAP.message) + '</span></div>' : '';
  if (!WSNAP.windows.length) return line + '<div class="wsnapnote">No other app windows are open.</div>';
  return line + '<div class="wsnapgrid" role="list">' + WSNAP.windows.map(wsnapTileHTML).join('') + '</div>';
}
function wsnapTileHTML(w) {
  const busy = WSNAP.state === 'capturing';
  const mine = busy && WSNAP.busyId === w.id;
  return '<button class="wsnaptile' + (mine ? ' is-busy' : '') + '" role="listitem" data-wsnap-pick="' + esc(w.id) + '"'
    + (busy ? ' disabled' : '') + ' title="' + esc(w.name) + '" aria-label="Attach ' + esc(w.name) + '">'
    + '<span class="wsnapthumb"><img alt="" src="' + esc(w.thumb) + '">'
    + (mine ? '<span class="attspin" aria-label="Capturing"></span>' : '') + '</span>'
    + '<span class="wsnapname">' + (w.icon ? '<img class="wsnapicon" alt="" src="' + esc(w.icon) + '">' : ic('appwin'))
    + '<span>' + esc(w.name) + '</span></span></button>';
}
function wsnapHTML() {
  return '<div class="wsnapscrim" id="wsnap" data-wsnap-scrim="1">'
    + '<div class="wsnap" role="dialog" aria-modal="true" aria-labelledby="wsnaptitle">'
    + '<div class="wsnaphead"><div><div class="wsnaptitle" id="wsnaptitle">Attach a window</div>'
    + '<div class="wsnapsub">A snapshot of the window you pick is added to your message. Nothing in it is clicked or typed.</div></div>'
    + '<button class="wsnapx" data-wsnap-close="1" aria-label="Close" title="Close">' + ic('x') + '</button></div>'
    + '<div class="wsnapbody">' + wsnapBodyHTML() + '</div>'
    + '</div></div>';
}
function wsnapPaint() {
  if (typeof document === 'undefined') return;
  const old = document.getElementById('wsnap');
  const btn = document.querySelector('#composer .wsnapbtn');
  if (btn) btn.classList.toggle('is-open', WSNAP.state !== 'closed');
  if (WSNAP.state === 'closed') { if (old) old.remove(); return; }
  const host = document.getElementById('window') || document.body;
  const tmp = document.createElement('div');
  tmp.innerHTML = wsnapHTML();
  const node = tmp.firstChild;
  if (old) old.replaceWith(node); else host.appendChild(node);
}

/* ---------- flow ---------- */

async function wsnapOpen() {
  if (!(BR && BR.snapshotWindows && BR.snapshotCapture)) { toast('Attaching a window needs a newer app build', '', 'bad'); return; }
  if (typeof attCanDrop === 'function' && !attCanDrop()) { toast('Open a chat to attach a window', ''); return; }
  if (typeof ATT !== 'undefined' && ATT.menu) { ATT.menu = false; if (typeof attRepaint === 'function') attRepaint(); }
  WSNAP.returnFocus = document.activeElement;
  WSNAP.message = '';
  await wsnapList();
}
async function wsnapList() {
  const seq = ++WSNAP.seq;
  WSNAP.state = 'loading';
  WSNAP.windows = [];
  wsnapPaint();
  let res;
  try { res = await BR.snapshotWindows(); } catch (e) { res = null; }
  if (seq !== WSNAP.seq || WSNAP.state === 'closed') return;
  const view = wsnapListView(res);
  WSNAP.state = view.state;
  WSNAP.windows = view.windows || [];
  if (view.state !== 'list') WSNAP.message = view.message;
  wsnapPaint();
  const first = document.querySelector('#wsnap [data-wsnap-pick]') || document.querySelector('#wsnap [data-wsnap-close]');
  if (first) first.focus();
}
function wsnapClose() {
  if (WSNAP.state === 'closed') return;
  WSNAP.seq++;
  WSNAP.state = 'closed';
  WSNAP.windows = [];
  WSNAP.busyId = null;
  WSNAP.message = '';
  wsnapPaint();
  const back = WSNAP.returnFocus;
  WSNAP.returnFocus = null;
  const entry = typeof $ === 'function' ? $('#entry') : null;
  if (entry) entry.focus(); else if (back && back.focus) back.focus();
}
async function wsnapPick(id) {
  if (WSNAP.state !== 'list' || !id) return;
  const seq = ++WSNAP.seq;
  WSNAP.state = 'capturing';
  WSNAP.busyId = id;
  WSNAP.message = '';
  wsnapPaint();
  let res;
  try { res = await BR.snapshotCapture(id); } catch (e) { res = null; }
  if (seq !== WSNAP.seq || WSNAP.state === 'closed') return;
  WSNAP.busyId = null;
  const view = wsnapCaptureView(res);
  if (view.ok) {
    const bytes = view.bytes instanceof Uint8Array ? view.bytes : new Uint8Array(view.bytes);
    let file;
    try { file = new File([bytes], view.name, {type: view.type, lastModified: Date.now()}); } catch (e) { file = null; }
    wsnapClose();
    // The same door as a pasted screenshot: attachments.js reads, thumbnails and saves it.
    if (file) attAdd([{file}], 'window');
    else toast('The window could not be attached', '', 'bad');
    return;
  }
  if (view.state === 'relist') {
    await wsnapList();
    if (WSNAP.state === 'list') { WSNAP.message = view.message; wsnapPaint(); }
    return;
  }
  WSNAP.state = view.state;
  WSNAP.message = view.message;
  wsnapPaint();
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('[data-wsnap-open]')) { e.preventDefault(); if (WSNAP.state === 'closed') wsnapOpen(); else wsnapClose(); return; }
    if (WSNAP.state === 'closed') return;
    if (t.closest('[data-wsnap-close]')) { e.preventDefault(); wsnapClose(); return; }
    const pick = t.closest('[data-wsnap-pick]');
    if (pick) { e.preventDefault(); wsnapPick(pick.getAttribute('data-wsnap-pick')); return; }
    // A click on the dimmed window around the sheet closes it.
    if (t.closest('[data-wsnap-scrim]') && !t.closest('.wsnap')) { e.preventDefault(); wsnapClose(); }
  });
  document.addEventListener('keydown', (e) => {
    if (WSNAP.state !== 'closed' && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); wsnapClose(); }
  }, true);
}

if (typeof module !== 'undefined') {
  module.exports = {wsnapSafeImage, wsnapListView, wsnapCaptureView};
}
