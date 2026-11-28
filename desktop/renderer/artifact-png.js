/* ---------------- ATO-2457: Save as PNG ----------------
   A canvas, a live widget or an MCP App in the chat (its sandboxed frame,
   chat-artifact.js) and a ui.render card (ui-render.js) carry a "Save as
   PNG" button. The click brings the card into view, sends its box to main
   (main/artifact-png.ts), which grabs that part of the window and asks
   where to save it (Downloads by default). What is on screen is what is
   saved: a card taller than the window is cut at its edge.

   The page in the frame is never asked: the picture is of the app window.

   Loaded after chat-artifact.js and ui-render.js; renderer globals
   (toast, ic) are read at call time. Pure part exported for
   test/artifact-png.test.mjs. */

const APNG = {busy: false};

function apngEsc(s) { return String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c])); }

/** The bar's button for an artifact `key` (chatArtifactSlotHTML draws it once the page has loaded). */
function artifactPngButtonHTML(key, escape) {
  const e = typeof escape === 'function' ? escape : apngEsc;
  return '<button class="chat-art-png" data-artpng="' + e(key) + '" title="Save what the card shows as a PNG picture">'
    + (typeof ic === 'function' ? ic('download') : '') + '<span>Save as PNG</span></button>';
}

/** The element whose box is saved, and the name for the file, or null. */
function apngTargetOf(btn) {
  if (!btn || !btn.dataset) return null;
  if (btn.dataset.artpng) {
    const st = typeof CHAT_ART !== 'undefined' ? CHAT_ART.get(btn.dataset.artpng) : null;
    return st && st.node && st.node.isConnected ? {el: st.node, title: st.title || 'Artifact'} : null;
  }
  if (btn.dataset.uirpng) {
    const box = btn.closest ? btn.closest('[data-uir]') : null;
    const st = typeof UIR !== 'undefined' ? UIR.get(btn.dataset.uirpng) : null;
    return box ? {el: box, title: (st && st.spec.title) || 'Card'} : null;
  }
  return null;
}

/** A DOMRect as the plain box main reads. */
function apngRect(r) {
  return {x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height)};
}

/** What the person is told after a save; null when nothing needs saying (they closed the dialog). */
function apngToastOf(res) {
  if (res && res.ok) return {t: 'Saved as PNG', s: String(res.path || '').split(/[\\/]/).pop() || 'Saved', kind: ''};
  const reason = res && res.reason;
  if (reason === 'canceled') return null;
  if (reason === 'bad-rect') return {t: 'Couldn’t save the picture', s: 'Scroll the card into view and try again.', kind: 'bad'};
  return {t: 'Couldn’t save the picture', s: 'Try again, or take a screenshot instead.', kind: 'bad'};
}

function apngNextFrame() {
  return new Promise((r) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => requestAnimationFrame(r)) : setTimeout(r, 32)));
}

async function artifactPngSave(btn) {
  const br = typeof window !== 'undefined' && window.atomic ? window.atomic : null;
  const target = apngTargetOf(btn);
  if (APNG.busy || !target || !br || typeof br.artifactPng !== 'function') return;
  APNG.busy = true;
  const card = target.el.closest ? (target.el.closest('.chat-art, .uir') || target.el) : target.el;
  try {
    if (typeof target.el.scrollIntoView === 'function') target.el.scrollIntoView({block: 'nearest'});
    if (card.classList) card.classList.add('png-capturing');   // its own buttons stay out of the picture
    await apngNextFrame();
    const res = await br.artifactPng(apngRect(target.el.getBoundingClientRect()), target.title);
    const t = apngToastOf(res);
    if (t && typeof toast === 'function') toast(t.t, t.s, t.kind || undefined);
  } catch (e) {
    const t = apngToastOf(null);
    if (typeof toast === 'function') toast(t.t, t.s, t.kind);
  } finally {
    if (card.classList) card.classList.remove('png-capturing');
    APNG.busy = false;
  }
}

if (typeof document !== 'undefined') {
  /* Capture phase, as canvas-pane.js: the reply's own click handling should not also run. */
  document.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('[data-artpng], [data-uirpng]') : null;
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    artifactPngSave(b);
  }, true);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {APNG, artifactPngButtonHTML, apngTargetOf, apngRect, apngToastOf, artifactPngSave};
}
