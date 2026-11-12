/* ---------------- ATO-1136: HTML artifacts in the chat, sandboxed ----------------
   A page the agent made (a chart, a small dashboard, a mini app) is drawn in
   the reply and runs there, with nothing of the window's:

   - where one comes from: `event: canvas` (`{id, title?, html, path?}`, the
     agent's canvas.render, ATO-1137), a reply's own .html file (read through
     main's preview check, file-preview.ts, so only inside the allowed roots
     and at most 512 KB), or a ```html block the person asks to preview (its
     Preview button, beside Copy);
   - how it runs: main keeps the page's text and serves it from its own
     scheme (`atomic-art://<token>/`, main/artifact-frame.ts) under a strict
     CSP (inline script and style; no network, no frames, no forms; images
     only data:/blob:). The <iframe> is `sandbox="allow-scripts"` with no
     allow-same-origin, so the page has an opaque origin, no Node, no preload,
     no `window.atomic`, no popups, and cannot navigate the app window; main
     refuses it every permission and every navigation off these schemes.
     `srcdoc` would have been simpler, but a srcdoc document inherits the
     window's own CSP (`script-src 'self'`) and its script would never run.
   - how it survives a repaint: the transcript is rebuilt from HTML strings
     on every stream frame, and an <iframe> taken out of the document reloads.
     So the reply draws an empty box (`data-chat-art`) marked
     `data-morph-keep` (dom-morph.js leaves such a node alone), and the box is
     given the artifact's one frame after the paint, as chat-media.js does for
     a video. The page posts its height (main appends the few lines that do)
     and the frame takes it, between ART_MIN_H and ART_MAX_H.

   Loaded before renderer.js; only declares. The pure part is exported for
   test/chat-artifact.test.mjs. */

const ART_SANDBOX = 'allow-scripts';
/* Permissions policy for the frame: none of these, whatever main would answer. */
const ART_ALLOW = "camera 'none'; microphone 'none'; geolocation 'none'; display-capture 'none'; clipboard-read 'none'; "
  + "clipboard-write 'none'; fullscreen 'none'; payment 'none'; usb 'none'; serial 'none'; hid 'none'; bluetooth 'none'";
const ART_MIN_H = 80;
const ART_MAX_H = 1400;
const ART_DEFAULT_H = 320;
const ART_HTML_EXT = /\.html?$/i;
/* A page sent by an event or a code block: at most this many characters (main caps it at 4 MB too). */
const ART_HTML_MAX = 2 * 1024 * 1024;

/* key → {key, title, html, url, node, state 'loading'|'ok'|'fail', h, rev}. One frame per artifact. */
const CHAT_ART = new Map();
/* The ```html blocks whose preview is open, by their key. */
const ART_CODE_OPEN = new Set();

function artBridge() { return typeof window !== 'undefined' && window.atomic ? window.atomic : null; }
function artEsc(s) { return String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c])); }
function artIcon(n) { return typeof ic === 'function' ? ic(n) : ''; }

/** A reply file that is drawn as an artifact. */
function isHtmlArtifactPath(p) { return ART_HTML_EXT.test(String(p || '')); }

/** The height a page asked for, as the frame takes it. */
function artClampHeight(h) {
  const n = Number(h);
  if (!Number.isFinite(n) || n <= 0) return ART_DEFAULT_H;
  return Math.min(Math.max(Math.ceil(n), ART_MIN_H), ART_MAX_H);
}

/** FNV-1a, hex: a short stable key for a code block's text. */
function artHash(s) {
  let h = 0x811c9dc5;
  const t = String(s);
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0') + t.length.toString(16);
}

/** `event: canvas`'s payload, checked: {id, title, html, path} or null (nothing to draw). */
function artifactFromEvent(p) {
  if (!p || typeof p !== 'object') return null;
  const id = typeof p.id === 'string' ? p.id.trim().slice(0, 200) : '';
  if (!id) return null;
  const title = typeof p.title === 'string' ? p.title.trim().slice(0, 120) : '';
  const path = typeof p.path === 'string' && p.path.length < 4096 ? p.path : '';
  const html = typeof p.html === 'string' && p.html.trim() && p.html.length <= ART_HTML_MAX ? p.html : '';
  if (!html) return null;
  return {id, title, html, path};
}

/** The window's theme now, for the frame's colour scheme (the page's prefers-color-scheme follows it). */
function artTheme() {
  if (typeof document === 'undefined') return 'light';
  const set = document.documentElement.getAttribute('data-theme');
  if (set === 'dark' || set === 'light') return set;
  return typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Something about an artifact changed (it loaded, it failed, a preview opened): the transcript draws it again.
    A ```html block's preview is part of its message's markup, which renderer.js keeps made (PROSE_CACHE): that goes stale. */
function artChanged(key) {
  if (String(key || '').startsWith('code:') && typeof PROSE_CACHE !== 'undefined') PROSE_CACHE.ver++;
  if (typeof chatImagesChanged === 'function') chatImagesChanged();
}

function artEntry(key, title) {
  let st = CHAT_ART.get(key);
  if (!st) {
    st = {key, title: title || '', html: '', url: '', node: null, state: 'loading', h: ART_DEFAULT_H, rev: 0};
    CHAT_ART.set(key, st);
  } else if (title) st.title = title;
  return st;
}

/** The artifact's frame, made once. `sandbox` goes on before `src`. */
function artNode(st) {
  if (st.node || typeof document === 'undefined') return st.node;
  const f = document.createElement('iframe');
  f.className = 'chat-art-frame';
  f.setAttribute('sandbox', ART_SANDBOX);
  f.setAttribute('allow', ART_ALLOW);
  f.setAttribute('referrerpolicy', 'no-referrer');
  f.setAttribute('title', st.title || 'Artifact');
  f.style.height = st.h + 'px';
  f.style.colorScheme = artTheme();
  if (st.url) f.src = st.url;
  st.node = f;
  return f;
}

/**
 * Show `html` as the artifact `key`: a new one is kept in main and gets its
 * frame; one already on screen loads the new page in the same frame, where it
 * is (ATO-1140's "edit in place" rests on this). Answers the artifact's state.
 */
function chatArtifactSet(key, html, opts) {
  const st = artEntry(key, opts && opts.title);
  if (typeof html !== 'string' || !html.trim()) { st.state = 'fail'; return st; }
  if (st.html === html && st.state !== 'fail') return st;
  st.html = html;
  const rev = ++st.rev;
  const br = artBridge();
  if (!br || typeof br.artifactPut !== 'function') { st.state = 'fail'; return st; }
  Promise.resolve(br.artifactPut(html)).then((r) => {
    if (rev !== st.rev) { if (r && r.ok && br.artifactDrop) br.artifactDrop(r.url); return; }
    if (!r || !r.ok || typeof r.url !== 'string') { st.state = 'fail'; artChanged(key); return; }
    const old = st.url;
    st.url = r.url;
    st.state = 'ok';
    if (old && old !== r.url && br.artifactDrop) br.artifactDrop(old);
    if (st.node) { st.node.style.colorScheme = artTheme(); st.node.src = r.url; }
    artChanged(key);
  }, () => { if (rev === st.rev) { st.state = 'fail'; artChanged(key); } });
  return st;
}

/** The box a reply draws for an artifact; null when it cannot be shown (the caller draws a chip, or nothing). */
function chatArtifactSlotHTML(key, opts) {
  const st = CHAT_ART.get(key);
  if (!st || st.state === 'fail') return null;
  const o = opts || {};
  const e = typeof o.escape === 'function' ? o.escape : artEsc;
  const title = o.title || st.title || 'Artifact';
  const file = o.path
    ? '<button class="filechip chat-art-file" data-file="' + e(o.path) + '" data-reply="1" title="' + e(o.path) + '">'
      + artIcon('file') + '<span>' + e(String(o.path).split(/[\\/]/).pop() || o.path) + '</span></button>'
    : '';
  return '<div class="chat-art' + (st.state === 'ok' ? '' : ' loading') + '" data-art="' + e(key) + '">'
    + '<div class="chat-art-bar">' + artIcon('globe') + '<span class="chat-art-title">' + e(title) + '</span>' + file + '</div>'
    + '<div class="chat-art-box" data-chat-art="' + e(key) + '" data-morph-keep="art:' + e(key) + '"></div>'
    + '</div>';
}

/* ---------- where artifacts come from ---------- */

/** `event: canvas` into the reply `item`: its artifact list, and the page shown. False when there is nothing to draw. */
function chatArtifactEvent(item, payload) {
  const a = artifactFromEvent(payload);
  if (!item || !a) return false;
  const key = 'id:' + a.id;
  const list = Array.isArray(item.artifacts) ? item.artifacts : (item.artifacts = []);
  const had = list.find((x) => x.key === key);
  if (had) { had.title = a.title || had.title; had.path = a.path || had.path; }
  else list.push({key, title: a.title, path: a.path});
  chatArtifactSet(key, a.html, {title: a.title});
  return true;
}

/** The boxes for a reply's own artifacts (event ones), in order. */
function chatArtifactEventSlots(m, escape) {
  const out = [];
  for (const a of (m && Array.isArray(m.artifacts) ? m.artifacts : [])) {
    const h = chatArtifactSlotHTML(a.key, {title: a.title, path: a.path, escape});
    if (h) out.push(h);
  }
  return out;
}

/**
 * A reply's .html file: its box once main has read it (the read starts the
 * first time it is asked for). null: not shown as an artifact (not .html, out
 * of the roots, too large to read whole, failed); the caller draws a chip.
 * '': already drawn by the reply's own artifact of that file.
 */
function chatArtifactFileSlotHTML(path, escape, m) {
  if (!isHtmlArtifactPath(path)) return null;
  if (m && Array.isArray(m.artifacts) && m.artifacts.some((a) => a.path === path && CHAT_ART.has(a.key) && CHAT_ART.get(a.key).state !== 'fail')) return '';
  const key = 'file:' + path;
  const name = String(path).split(/[\\/]/).pop() || path;
  if (!CHAT_ART.has(key)) {
    const st = artEntry(key, name);
    const br = artBridge();
    if (!br || typeof br.filePreview !== 'function') st.state = 'fail';
    else {
      Promise.resolve(br.filePreview(path)).then((d) => {
        if (!d || !d.ok || d.kind !== 'html' || d.truncated || typeof d.text !== 'string') { st.state = 'fail'; artChanged(); return; }
        chatArtifactSet(key, d.text, {title: name});
      }, () => { st.state = 'fail'; artChanged(); });
    }
  }
  return chatArtifactSlotHTML(key, {title: name, path, escape});
}

/** A ```html block's key, from its drawn <pre> (the same text gives the same key on every repaint). */
function chatArtifactCodeKey(pre) { return 'code:' + artHash(pre); }

/** A fenced block's Preview button: only for ```html / ```htm, and only once the fence is closed. */
function chatArtifactCodeButton(pre, lang) {
  if (!/^html?$/i.test(String(lang || '')) || /^<pre class="mdpre"[^>]*\sdata-open="1"/.test(String(pre))) return '';
  const key = chatArtifactCodeKey(pre);
  const open = ART_CODE_OPEN.has(key);
  return '<button class="mdcopy" data-artprev="' + artEsc(key) + '" title="' + (open ? 'Hide the preview' : 'Run this page here, sandboxed, with no network') + '"'
    + ' aria-label="' + (open ? 'Hide preview' : 'Preview') + '">' + artIcon(open ? 'x' : 'eye') + '<span>' + (open ? 'Hide' : 'Preview') + '</span></button>';
}

/** The open preview under a ```html block ('' while closed). */
function chatArtifactCodeSlot(pre) {
  const key = chatArtifactCodeKey(pre);
  if (!ART_CODE_OPEN.has(key)) return '';
  return chatArtifactSlotHTML(key, {title: 'Preview'}) || '';
}

/** Preview / Hide on a ```html block: `code` is the block's text as drawn. True when handled. */
function chatArtifactToggleCode(key, code) {
  if (!key) return false;
  if (ART_CODE_OPEN.has(key)) ART_CODE_OPEN.delete(key);
  else {
    ART_CODE_OPEN.add(key);
    const st = chatArtifactSet(key, String(code || '').slice(0, ART_HTML_MAX), {title: 'Preview'});
    if (st.state === 'fail') { CHAT_ART.delete(key); ART_CODE_OPEN.delete(key); }
  }
  artChanged(key);
  return true;
}

/* ---------- the frames, after each paint ---------- */

/** Put each artifact's frame into the boxes the last paint left empty. One frame per artifact: a second box waits. */
function chatArtifactHydrate(root) {
  const scope = root || (typeof document !== 'undefined' ? document : null);
  if (!scope || !CHAT_ART.size) return;
  scope.querySelectorAll('[data-chat-art]').forEach((box) => {
    const st = CHAT_ART.get(box.dataset.chatArt);
    if (!st || st.state !== 'ok') return;
    const node = artNode(st);
    if (!node || box.contains(node) || node.isConnected) return;
    box.appendChild(node);
    const card = box.closest && box.closest('.chat-art');
    if (card) card.classList.remove('loading');
  });
}

/** A page's height (the one message read from a frame; the sender must be one of ours). */
function chatArtifactMessage(e) {
  const d = e && e.data;
  if (!d || typeof d !== 'object' || d.atomicArtifact !== 'size') return false;
  for (const st of CHAT_ART.values()) {
    if (st.node && st.node.contentWindow && st.node.contentWindow === e.source) {
      st.h = artClampHeight(d.h);
      st.node.style.height = st.h + 'px';
      return true;
    }
  }
  return false;
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('message', chatArtifactMessage);
}
if (typeof MutationObserver === 'function' && typeof document !== 'undefined') {
  new MutationObserver(() => { if (CHAT_ART.size) chatArtifactHydrate(); })
    .observe(document.documentElement, {childList: true, subtree: true});
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {ART_SANDBOX, ART_ALLOW, ART_MIN_H, ART_MAX_H, ART_DEFAULT_H, CHAT_ART, ART_CODE_OPEN,
    isHtmlArtifactPath, artClampHeight, artHash, artifactFromEvent, chatArtifactSet, chatArtifactSlotHTML, chatArtifactEvent,
    chatArtifactEventSlots, chatArtifactFileSlotHTML, chatArtifactCodeKey, chatArtifactCodeButton, chatArtifactCodeSlot,
    chatArtifactToggleCode, chatArtifactHydrate, chatArtifactMessage, artNode};
}
