/* ---------------- media in the chat: videos, long tool calls ----------------
   A reply's video (.mp4, .webm, .m4v) plays in the reply, like its pictures
   (ATO-408), with "Open in Studio" under it. The transcript is rebuilt from
   HTML strings on every stream frame, so a <video> written into that string
   would start again on every frame: the reply draws an empty slot
   (`data-chat-vid`) and the slot is given the video's one element after the
   paint (chatVideoHydrate), the way hydrateChatImages puts pictures in. The
   window's CSP allows `media-src file:`; the URL is STUDIO.mediaUrl's.

   `video.generate` takes minutes. The agent sends `event: tool_update`
   (`{tool, fraction, elapsed_ms, label}`, at most one every 20 s) and the
   running card shows how far it got (toolUpdateTarget, toolUpdateApply,
   toolProgressHTML). Its card and its paid approval are labelled like
   image.generate's (#678): videoToolLine, VIDEO_PAID_WHY.

   Loaded before renderer.js; only declares. The pure part is exported for
   test/chat-media.test.mjs. */

const CHAT_VIDEO_EXT = /\.(mp4|webm|m4v)$/i;
const CHAT_PICTURE_EXT = /\.(png|jpe?g|webp|gif)$/i;   // renderer.js CHAT_IMG_EXT
/* src/local-llm/core/core-video.ts DEFAULT_OPENROUTER_VIDEO_MODEL: what the
   tool runs when the call names no model (Core's own default comes first,
   and it is the same model today). */
const VIDEO_DEFAULT_MODEL = 'google/veo-3.1-fast';
const VIDEO_DEFAULT_SECS = 4;   // src/tools/video/args.ts VIDEO_DEFAULT_DURATION
const VIDEO_PAID_WHY = "OpenRouter charges your account for this video. Stop doesn't cancel the charge.";

/** 'image' | 'video' | null for a reply's file path. */
function chatMediaKind(path) {
  const p = String(path || '');
  if (CHAT_VIDEO_EXT.test(p)) return 'video';
  if (CHAT_PICTURE_EXT.test(p)) return 'image';
  return null;
}

/** `google/veo-3.1-fast` → `Veo 3.1 Fast`. */
function videoModelName(id) {
  const tail = String(id || '').split('/').pop().split(':')[0];
  if (!tail) return '';
  return tail.split(/[-_]+/).filter(Boolean)
    .map((w) => /^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** ATO-815: the model the call really ran on, as the tool says it: its result
    ("…video made with google/veo-3.1-fast on OpenRouter:"), or while it runs
    its progress label ("sent to google/veo-3.1-fast on OpenRouter", "making
    the video with google/veo-3.1-fast · about 40% · …"). '' when neither
    names one (an older agent, a failed call, nothing heard yet). */
function videoModelRan(out, label) {
  const done = /video made with (\S+) on OpenRouter/.exec(String(out || ''));
  if (done) return done[1];
  const live = /^(?:sent to|making the video with) (\S+?)(?: on OpenRouter| ·|$)/.exec(String(label || ''));
  return live ? live[1] : '';
}

/** The card's words for video.generate: "Generated a video · 4 s · Veo 3.1 Fast" (toolTense makes it "Generating").
    `ran` = {out, label}: the card's result and progress label. The model comes
    from them when they name it (ATO-815); the call's own `model` and then the
    tool's default are only the fallback, since the args may be missing or
    clipped. */
function videoToolLine(args, ran) {
  const a = args && typeof args === 'object' ? args : {};
  const secs = Number.isInteger(a.duration) && a.duration > 0 ? a.duration : VIDEO_DEFAULT_SECS;
  const r = ran && typeof ran === 'object' ? ran : {};
  const asked = typeof a.model === 'string' && a.model.trim() && a.model.trim().toLowerCase() !== 'local' ? a.model.trim() : '';
  const model = videoModelRan(r.out, r.label) || asked || VIDEO_DEFAULT_MODEL;
  return 'Generated a video · ' + secs + ' s · ' + videoModelName(model);
}

/* ---------- tool_update: how far a long call got ---------- */

/** The card a `tool_update` is about: the newest card of that tool still running in that turn. */
function toolUpdateTarget(log, payload, turnId) {
  const tool = String((payload && payload.tool) || '');
  if (!tool || !Array.isArray(log)) return null;
  for (let i = log.length - 1; i >= 0; i--) {
    const c = log[i];
    if (c && c.k === 'tool' && c.name === tool && c.ok === null && (turnId == null || c.turn === turnId)) return c;
  }
  return null;
}

/** Folds one `tool_update` into the card: `progress = {fraction 0..1, elapsedMs, label, at}`. A fraction never goes back. */
function toolUpdateApply(card, payload, at) {
  if (!card || !payload) return card;
  const prev = card.progress || null;
  let f = Number(payload.fraction);
  f = Number.isFinite(f) ? Math.min(Math.max(f, 0), 1) : 0;
  if (prev && prev.fraction > f) f = prev.fraction;
  const ms = Number(payload.elapsed_ms != null ? payload.elapsed_ms : payload.elapsedMs);
  card.progress = {
    fraction: f,
    elapsedMs: Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : (prev ? prev.elapsedMs : 0),
    label: typeof payload.label === 'string' ? payload.label.slice(0, 200) : (prev ? prev.label : ''),
    at: Number.isFinite(at) ? at : Date.now(),
  };
  return card;
}

/** "About 42% · 2 min" for the running card; '' before any update. A cloud clip's percent is only Core's guess, hence "About". */
function toolProgressText(progress) {
  if (!progress) return '';
  const pct = Math.round(Math.min(progress.fraction, 0.99) * 100);
  const min = Math.floor((progress.elapsedMs || 0) / 60000);
  const elapsed = min >= 1 ? min + ' min' : Math.max(0, Math.round((progress.elapsedMs || 0) / 1000)) + ' s';
  return (pct > 0 ? 'About ' + pct + '%' : 'Sent, waiting for the provider') + ' · ' + elapsed;
}

/** The line under a running card's head (html); '' when it has no progress. */
function toolProgressHTML(card, escape) {
  if (!card || card.ok !== null || !card.progress) return '';
  const e = typeof escape === 'function' ? escape : (s) => String(s);
  const pct = Math.round(Math.min(card.progress.fraction, 0.99) * 100);
  return '<div class="cardsum tl-prog" role="status"><span class="tl-prog-bar"><i style="width:' + pct + '%"></i></span>'
    + '<span class="tl-prog-t tnum">' + e(toolProgressText(card.progress)) + '</span></div>';
}

/* ---------- a reply's videos ---------- */

/* path → {node, failed, playing}. One element per video, so a repaint moves it rather than
   reloading it. A playing <video> taken out of the document is paused by the browser; the
   repaint puts it back at once (chatVideoHydrate, in the same turn of the event loop) and
   starts it again if the person had not paused it (`playing` drops only on their pause). */
const CHAT_VID = new Map();

function chatVideoUrl(path) {
  if (typeof window !== 'undefined' && window.STUDIO && typeof window.STUDIO.mediaUrl === 'function') return window.STUDIO.mediaUrl(path);
  return '';
}

/** The video's state, its element made the first time it is asked for. */
function chatVideo(path) {
  let st = CHAT_VID.get(path);
  if (st) return st;
  st = {node: null, failed: false, playing: false};
  CHAT_VID.set(path, st);
  const url = chatVideoUrl(path);
  if (!url || typeof document === 'undefined') { st.failed = true; return st; }
  const v = document.createElement('video');
  v.className = 'chat-vid-player';
  v.controls = true;
  v.preload = 'metadata';
  v.playsInline = true;
  v.addEventListener('playing', () => { st.playing = true; });
  v.addEventListener('pause', () => { if (v.isConnected) st.playing = false; });
  v.addEventListener('ended', () => { st.playing = false; });
  v.addEventListener('error', () => {
    st.failed = true;
    if (typeof chatImagesChanged === 'function') chatImagesChanged();
  });
  v.src = url;
  st.node = v;
  return st;
}

/** The slot a reply draws for a video; null when it cannot play (a chip is drawn instead). */
function chatVideoSlotHTML(path, escape) {
  const st = chatVideo(path);
  if (st.failed) return null;
  const e = typeof escape === 'function' ? escape : (s) => String(s);
  const name = String(path).split(/[\\/]/).pop() || path;
  return '<div class="chat-vid" data-chat-vid="' + e(path) + '" title="' + e(name) + '"></div>';
}

/** Put each video's element into the slots the last paint left empty. */
function chatVideoHydrate(root) {
  const scope = root || (typeof document !== 'undefined' ? document : null);
  if (!scope || !CHAT_VID.size) return;
  scope.querySelectorAll('[data-chat-vid]:not([data-hyd])').forEach((slot) => {
    const st = CHAT_VID.get(slot.dataset.chatVid);
    if (!st || !st.node || st.failed) return;
    slot.dataset.hyd = '1';
    // A second copy on screen at once gets its own element (same file, paused).
    const node = st.node.isConnected && !slot.contains(st.node) ? st.node.cloneNode(false) : st.node;
    slot.appendChild(node);
    if (node === st.node && st.playing && node.paused) node.play().catch(() => { st.playing = false; });
  });
}
if (typeof MutationObserver === 'function' && typeof document !== 'undefined') {
  // Not deferred to a frame: the element must be back before the browser settles the removal.
  new MutationObserver(() => { if (CHAT_VID.size) chatVideoHydrate(); })
    .observe(document.documentElement, {childList: true, subtree: true});
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {chatMediaKind, videoModelName, videoModelRan, videoToolLine, toolUpdateTarget, toolUpdateApply, toolProgressText,
    toolProgressHTML, VIDEO_PAID_WHY, VIDEO_DEFAULT_MODEL};
}
