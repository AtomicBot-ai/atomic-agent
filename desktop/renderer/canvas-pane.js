/* ---------------- ATO-1055: a canvas beside the chat ----------------
   An artifact in a reply (chat-artifact.js: a canvas.render page, a reply's
   .html file, a ```html / ```chart preview) has an Expand button; it opens
   that same artifact in a pane on the right of the chat, larger, as
   Claude.ai's artifacts and ChatGPT's Canvas do.

   No new surface: the pane holds the artifact's own one <iframe>
   (CHAT_ART's `node`, made by artNode: sandbox="allow-scripts", no
   allow-same-origin, its page served from atomic-art://<token>/ under main's
   strict CSP). The frame is moved, not copied, so there is still one frame
   per artifact; a moved frame reloads, which a static page does not mind.
   While it is here the reply's box is empty (its card says the page is
   beside the chat), and chatArtifactHydrate leaves the frame alone because
   it is still in the document. Close or Back to chat takes it out of the
   pane, and the next hydrate puts it back in the reply.

   It follows the artifact: edit in place (ATO-1138) loads the new page into
   that same frame, so the pane shows it as it comes; the title is read again
   after every paint. When the artifact is gone (it failed, its preview was
   hidden, the reply is no longer on screen, another chat is) the pane closes.

   Its own <aside id="canvaspane">, drawn here and never by render(), next to
   the file preview (#fpreview); only one of the two is open at a time.
   Loaded after chat-artifact.js, before renderer.js. Pure helpers are
   exported for test/canvas-pane.test.mjs; the DOM part is behind
   `typeof document`. */

const CP_WIDTH_KEY = 'atomic.canvasPane.width';
const CP_MIN_W = 360;
const CP_DEFAULT_W = 620;
/* The one kind of page the pane shows: main's artifact scheme, a 32-hex token. */
const CP_URL_RE = /^atomic-art:\/\/[0-9a-f]{32}\/$/;

/* key: the artifact (CHAT_ART's key) on screen here, '' while closed. st: its CHAT_ART entry. */
const CP = {open: false, key: '', st: null, title: ''};

function cpEsc(s) { return String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c])); }
function cpIcon(n) { return typeof ic === 'function' ? ic(n) : ''; }
function cpEl() { return typeof document !== 'undefined' ? document.getElementById('canvaspane') : null; }
function cpArts() { return typeof CHAT_ART !== 'undefined' ? CHAT_ART : new Map(); }

/** The artifact open in the pane ('' when none): chat-artifact.js draws its card's Expand button from it. */
function canvasPaneKey() { return CP.open ? CP.key : ''; }

/** A page the pane may show: only an atomic-art: URL (or none yet, while it loads). */
function canvasPaneUrlOk(url) { return url === '' || url == null || CP_URL_RE.test(String(url)); }

/** A frame the pane may hold: the artifact's own, sandboxed to scripts only, on an atomic-art: page. */
function canvasPaneFrameOk(node) {
  if (!node || typeof node.getAttribute !== 'function') return false;
  const sb = String(node.getAttribute('sandbox') || '').trim().split(/\s+/);
  if (sb.length !== 1 || sb[0] !== 'allow-scripts') return false;
  if (node.hasAttribute && node.hasAttribute('srcdoc')) return false;
  return canvasPaneUrlOk(node.getAttribute('src') || '');
}

/** The pane's chrome: title, Back to chat, Close. The frame goes into `.cp-body` after. */
function canvasPaneHTML(title) {
  const t = String(title || '').trim() || 'Artifact';
  return '<div class="fp-resize cp-resize" data-cp="resize" title="Drag to resize" aria-hidden="true"></div>'
    + '<div class="fp-head cp-head"><span class="fp-ic">' + cpIcon('globe') + '</span>'
    + '<span class="fp-title"><span class="fp-name cp-name" title="' + cpEsc(t) + '">' + cpEsc(t) + '</span>'
    + '<span class="fp-meta">Runs sandboxed, with no network</span></span>'
    + '<button class="fp-btn" data-cp="back" title="Put it back in the reply and scroll to it">' + cpIcon('chevL') + '<span>Back to chat</span></button>'
    + '<button class="fp-btn fp-x" data-cp="close" title="Close the canvas" aria-label="Close the canvas">✕</button></div>'
    + '<div class="cp-body" tabindex="-1"></div>';
}

/** Is the artifact `key` still there to show: kept, not failed, and (a code block's preview) still open. */
function canvasPaneLive(key, arts, codeOpen) {
  const st = arts && arts.get(key);
  if (!st || st.state === 'fail') return false;
  if (String(key).startsWith('code:') && codeOpen && !codeOpen.has(key)) return false;
  return true;
}

/* ---------- the DOM ---------- */

/** The reply's box for `key` (never one inside the pane). */
function cpBox(key) {
  if (typeof document === 'undefined') return null;
  for (const b of document.querySelectorAll('#content [data-chat-art]')) if (b.dataset.chatArt === key) return b;
  return null;
}

/** Put the artifact's frame in the pane, once it has a page. False when it may not be shown here. */
function cpAdopt(st) {
  const el = cpEl();
  const body = el && el.querySelector('.cp-body');
  if (!body || !st || st.state !== 'ok' || typeof artNode !== 'function') return true;
  const node = artNode(st);
  if (!canvasPaneFrameOk(node)) return false;
  if (node.parentNode !== body) { body.innerHTML = ''; body.appendChild(node); }
  return true;
}

/** Open the artifact `key` beside the chat (again on the same one: nothing changes). */
function canvasPaneOpen(key) {
  const el = cpEl();
  const st = cpArts().get(key);
  if (!el || !st || st.state === 'fail') return false;
  if (CP.open && CP.key === key) return true;
  if (CP.open) canvasPaneClose(false);
  // One panel beside the chat at a time.
  if (typeof FP !== 'undefined' && FP.open && typeof filePreviewClose === 'function') filePreviewClose();
  CP.open = true; CP.key = key; CP.st = st; CP.title = st.title || '';
  el.innerHTML = canvasPaneHTML(CP.title);
  el.hidden = false;
  cpApplyWidth();
  if (!cpAdopt(st)) { canvasPaneClose(false); return false; }
  cpChanged(key);
  return true;
}

/** Close the pane; the frame goes back to its reply on the next hydrate. `back`: and scroll the reply to it. */
function canvasPaneClose(back) {
  const el = cpEl();
  const key = CP.key;
  const st = CP.st;
  CP.open = false; CP.key = ''; CP.st = null; CP.title = '';
  if (st && st.node && el && el.contains(st.node)) st.node.remove();
  if (el) { el.hidden = true; el.innerHTML = ''; }
  if (typeof chatArtifactHydrate === 'function') chatArtifactHydrate();
  if (key) cpChanged(key);
  if (back && key) {
    const card = cpBox(key) && cpBox(key).closest('.chat-art');
    if (card && typeof card.scrollIntoView === 'function') {
      card.scrollIntoView({block: 'center', behavior: 'smooth'});
      card.classList.add('cp-flash');
      setTimeout(() => card.classList.remove('cp-flash'), 1200);
    }
  }
}

/** The Expand button: open, or close when this artifact is the one already beside the chat. */
function canvasPaneToggle(key) {
  if (CP.open && CP.key === key) canvasPaneClose(false); else canvasPaneOpen(key);
}

/** The reply's card draws its button from canvasPaneKey(); a code block's markup is cached (PROSE_CACHE). */
function cpChanged(key) {
  if (String(key).startsWith('code:') && typeof PROSE_CACHE !== 'undefined') PROSE_CACHE.ver++;
  if (typeof chatImagesChanged === 'function') chatImagesChanged();
}

/** After every paint: still there? The same entry (a failed canvas is made again)? A new title? */
function cpFollow() {
  if (!CP.open) return;
  if (!canvasPaneLive(CP.key, cpArts(), typeof ART_CODE_OPEN !== 'undefined' ? ART_CODE_OPEN : null) || !cpBox(CP.key)) {
    canvasPaneClose(false);
    return;
  }
  const st = cpArts().get(CP.key);
  if (st !== CP.st) {
    if (CP.st && CP.st.node && CP.st.node.isConnected) CP.st.node.remove();
    CP.st = st;
  }
  if (!cpAdopt(st)) { canvasPaneClose(false); return; }
  if ((st.title || '') !== CP.title) {
    CP.title = st.title || '';
    const n = cpEl() && cpEl().querySelector('.cp-name');
    if (n) { n.textContent = CP.title || 'Artifact'; n.title = CP.title || 'Artifact'; }
  }
}

/* ---------- width: dragged by the left edge, remembered ---------- */
function cpStoredWidth() {
  try { const v = parseInt(localStorage.getItem(CP_WIDTH_KEY) || '', 10); return v > 0 ? v : 0; } catch (e) { return 0; }
}
function cpMaxWidth() {
  const main = typeof document !== 'undefined' ? document.getElementById('main') : null;
  return Math.max(CP_MIN_W, Math.round((main ? main.clientWidth : 1200) * 0.7));
}
function cpApplyWidth(w) {
  const el = cpEl();
  if (!el) return;
  el.style.width = Math.max(CP_MIN_W, Math.min(cpMaxWidth(), w || cpStoredWidth() || CP_DEFAULT_W)) + 'px';
}

if (typeof document !== 'undefined') {
  /* Capture phase: the Expand button sits in a reply, whose own click handling in renderer.js should not also run. */
  document.addEventListener('click', (e) => {
    const t = e.target && e.target.closest ? e.target : null;
    if (!t) return;
    const ex = t.closest('[data-artexpand]');
    if (ex) { e.preventDefault(); e.stopPropagation(); canvasPaneToggle(ex.dataset.artexpand); return; }
    const b = t.closest('#canvaspane [data-cp]');
    if (!b || b.dataset.cp === 'resize') return;
    e.preventDefault(); e.stopPropagation();
    canvasPaneClose(b.dataset.cp === 'back');
  }, true);
  document.addEventListener('keydown', (e) => {
    /* As file-preview.js: renderer.js's Esc chain would otherwise also run (aborting a turn). */
    if (e.key === 'Escape' && CP.open && e.target && e.target.closest && e.target.closest('#canvaspane')) {
      e.preventDefault(); e.stopImmediatePropagation(); canvasPaneClose(false);
    }
  }, true);
  document.addEventListener('pointerdown', (e) => {
    const h = e.target && e.target.closest ? e.target.closest('#canvaspane .cp-resize') : null;
    if (!h) return;
    e.preventDefault();
    const el = cpEl();
    const startX = e.clientX, startW = el.getBoundingClientRect().width;
    el.classList.add('fp-dragging');
    const move = (ev) => cpApplyWidth(startW + (startX - ev.clientX));
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      el.classList.remove('fp-dragging');
      try { localStorage.setItem(CP_WIDTH_KEY, String(Math.round(el.getBoundingClientRect().width))); } catch (err) { /* not kept */ }
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  });
  window.addEventListener('resize', () => { if (CP.open) cpApplyWidth(); });
  let cpRaf = 0;
  const follow = () => { if (CP.open && !cpRaf) cpRaf = requestAnimationFrame(() => { cpRaf = 0; cpFollow(); }); };
  const start = () => {
    const content = document.getElementById('content');
    if (content && typeof MutationObserver === 'function') new MutationObserver(follow).observe(content, {childList: true, subtree: true});
    // The file preview opened: it takes the place beside the chat.
    const fp = document.getElementById('fpreview');
    if (fp && typeof MutationObserver === 'function') {
      new MutationObserver(() => { if (CP.open && !fp.hidden) canvasPaneClose(false); }).observe(fp, {attributes: true, attributeFilter: ['hidden']});
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {CP, CP_URL_RE, canvasPaneKey, canvasPaneUrlOk, canvasPaneFrameOk, canvasPaneHTML, canvasPaneLive};
}
