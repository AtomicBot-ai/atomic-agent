/* ---------------- ATO-403: files and images in the composer ----------------
   ATO-404  the "+" menu (Images / Files), a drop onto the window, ⌘V of a
            clipboard image, and the chips above the field.
   ATO-405  each file is saved into the desktop's inbox by main the moment it
            is added (main/attachments.ts), and the message that goes out is
            the caption plus the `[attachments]` block Telegram and Discord
            send (src/channels/attachments/inbox.ts). The agent server is not
            changed: the turn, the queue and a steer all carry that one string.
   ATO-406  a user message is drawn from that string: the block and its hint
            line come off, chips go in their place, live and on reopen.

   Loaded before renderer.js and only declares: it reads renderer.js globals
   (S, BR, ANX, SEL, render, refreshSend, toast, esc, ic, $) when a function
   runs. The pure part (classification, the message format, the size bucket)
   is exported for the unit suite at the bottom.

   Ported from Atomic Chat web-app/src: containers/chatInput/classifyDroppedPaths.ts
   (which extensions are images / documents) and lib/imageDownscale.ts (2048 px
   longest edge, WebP re-encoded). */

const ATT_IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);
// Audio is its own task (ATO-403 "not taken"): named, so the chip says so.
const ATT_AUDIO_EXTENSIONS = new Set(['mp3', 'wav']);
const ATT_DOCUMENT_EXTENSIONS = new Set([
  // Documents
  'pdf', 'docx', 'txt', 'md', 'csv', 'xlsx', 'xls', 'ods', 'pptx', 'html', 'htm',
  // JavaScript / TypeScript
  'js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'jsx', 'tsx',
  // Python
  'py', 'pyw', 'pyi',
  // C / C++
  'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh',
  // Systems languages
  'rs', 'go', 'swift', 'zig',
  // JVM languages
  'java', 'kt', 'kts', 'scala', 'groovy',
  // Scripting languages
  'rb', 'php', 'lua', 'pl', 'r', 'jl',
  // .NET
  'cs', 'fs', 'vb',
  // Shell
  'sh', 'bash', 'zsh', 'fish', 'ps1',
  // Web
  'css', 'scss', 'sass', 'less', 'vue', 'svelte', 'astro',
  // Data / config formats
  'json', 'jsonc', 'yaml', 'yml', 'toml', 'xml', 'ini', 'cfg', 'conf', 'env',
  // Query / markup
  'sql', 'graphql', 'gql', 'tex', 'rst',
  // Misc text
  'log', 'diff', 'patch',
]);

const ATT_MAX_DIMENSION_PX = 2048;
const ATT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;     // main/attachments.ts IMAGE_MAX_BYTES
const ATT_DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;  // main/attachments.ts DOCUMENT_MAX_BYTES
const ATT_MAX_ITEMS = 10;
const ATT_THUMB_PX = 112;                         // a 56 px tile at 2x
const ATT_HINT_LINE = 'The files are saved locally: read them with os.fs.read or os.fs.read_document; use vision.describe for images.';

/** The composer's chips. `status`: preparing → ready | error. */
const ATT = {items: [], seq: 0, menu: false, drag: 0};

/* ---------- classification (classifyDroppedPaths.ts) ---------- */

function attExtension(name) {
  return (String(name || '').split(/[\\/]/).pop().split('.').pop() || '').toLowerCase();
}
/** 'image' | 'audio' | 'document' | 'unsupported' for one file name. */
function attClassifyName(name) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  // Treat extensionless filenames (no dot in basename) as unsupported.
  if (!base.includes('.')) return 'unsupported';
  const ext = attExtension(base);
  if (ATT_IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (ATT_AUDIO_EXTENSIONS.has(ext)) return 'audio';
  if (ATT_DOCUMENT_EXTENSIONS.has(ext)) return 'document';
  return 'unsupported';
}
function attClassifyDroppedPaths(paths) {
  const out = {images: [], audio: [], docs: [], unsupported: []};
  for (const p of paths || []) {
    const k = attClassifyName(p);
    (k === 'image' ? out.images : k === 'audio' ? out.audio : k === 'document' ? out.docs : out.unsupported).push(p);
  }
  return out;
}
function attMimeFromName(name) {
  const ext = attExtension(name);
  return ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'png' ? 'image/png'
    : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : '';
}

/* ---------- the message format (inbox.ts, byte-identical) ---------- */

function attFormatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
/** items: [{path, mimeType, bytes}] (saved) or [{name, reason, failed:true}]. */
function attBuildMessage(caption, items) {
  const text = String(caption || '').trim();
  const saved = items.filter((i) => !i.failed).length;
  const head = text.length > 0 ? text
    : 'The user sent ' + (items.length === 1 ? 'a file' : items.length + ' files') + ' without a message.';
  const lines = items.map((i) => i.failed
    ? '- ' + i.name + ': not saved (' + i.reason + ')'
    : '- ' + i.path + ' (' + (i.mimeType || 'unknown type') + ', ' + attFormatBytes(i.bytes) + ')');
  const parts = [head, '', ['[attachments]'].concat(lines).join('\n')];
  if (saved > 0) parts.push(ATT_HINT_LINE);
  return parts.join('\n');
}
const ATT_STANDIN = /^The user sent (?:a file|\d+ files) without a message\.$/;
const ATT_SAVED_LINE = /^- (.+) \(([^,()]+), (\d+(?:\.\d+)? (?:B|KB|MB))\)$/;
const ATT_FAILED_LINE = /^- (.+): not saved \((.*)\)$/;
/**
 * A user message that carries an `[attachments]` block, taken apart:
 * `{caption, items:[{path, name, mimeType, size, kind} | {name, reason, failed:true}]}`.
 * Null when the text has no block, or one this format did not write (a line
 * that does not parse): such a message is drawn as typed.
 */
function attSplitMessage(text) {
  const s = String(text || '');
  const at = s.lastIndexOf('\n\n[attachments]\n');
  if (at < 0) return null;
  const lines = s.slice(at + '\n\n[attachments]\n'.length).split('\n');
  if (lines[lines.length - 1] === ATT_HINT_LINE) lines.pop();
  if (!lines.length) return null;
  const items = [];
  for (const line of lines) {
    let m = ATT_SAVED_LINE.exec(line);
    if (m) {
      const name = m[1].split(/[\\/]/).pop();
      const mimeType = m[2] === 'unknown type' ? null : m[2];
      items.push({path: m[1], name: attDisplayName(name), mimeType, size: m[3],
        kind: mimeType && mimeType.indexOf('image/') === 0 ? 'image' : 'document'});
      continue;
    }
    m = ATT_FAILED_LINE.exec(line);
    if (m) { items.push({name: m[1], reason: m[2], failed: true}); continue; }
    return null;
  }
  const head = s.slice(0, at);
  return {caption: ATT_STANDIN.test(head) ? '' : head, items};
}
/** The inbox name without its `HHMMSS-` stamp (and `-2` collision suffix stays). */
function attDisplayName(base) {
  return String(base || '').replace(/^\d{6}-/, '');
}
/** Analytics size bucket: never the size itself. */
function attSizeBucket(bytes) {
  return bytes < 100 * 1024 ? 'lt_100kb' : bytes < 1024 * 1024 ? 'lt_1mb' : bytes < 10 * 1024 * 1024 ? 'lt_10mb' : 'gte_10mb';
}

/* ---------- image downscale (imageDownscale.ts) ---------- */

const ATT_WEBP_TRANSCODE_MAX_PX = 4096;
const ATT_JPEG_QUALITY = 0.92;
const ATT_PNG_KEEP_BYTES = 4 * 1024 * 1024;
const ATT_ALPHA_SCAN_BAND_BYTES = 4 * 1024 * 1024;

function attBase64Bytes(b64) {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}
function attLoadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to decode image'));
    img.src = dataUrl;
  });
}
function attCanvasHasAlpha(ctx, width, height) {
  const rowsPerBand = Math.max(1, Math.floor(ATT_ALPHA_SCAN_BAND_BYTES / (width * 4)));
  for (let y = 0; y < height; y += rowsPerBand) {
    const rows = Math.min(rowsPerBand, height - y);
    const data = ctx.getImageData(0, y, width, rows).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return true;
  }
  return false;
}
/* JPEG stays JPEG; transparency becomes PNG; an opaque PNG/WebP is PNG unless
   that lands over 4 MB, when the smaller of PNG and JPEG wins (Atomic Chat #262). */
function attEncodeCanvas(canvas, ctx, mimeType) {
  if (mimeType === 'image/jpeg') return {dataUrl: canvas.toDataURL('image/jpeg', ATT_JPEG_QUALITY), mimeType: 'image/jpeg'};
  const png = canvas.toDataURL('image/png');
  if (attCanvasHasAlpha(ctx, canvas.width, canvas.height)) return {dataUrl: png, mimeType: 'image/png'};
  const pngBytes = attBase64Bytes(png.split(',')[1] || '');
  if (pngBytes <= ATT_PNG_KEEP_BYTES) return {dataUrl: png, mimeType: 'image/png'};
  const jpeg = canvas.toDataURL('image/jpeg', ATT_JPEG_QUALITY);
  const jpegBytes = attBase64Bytes(jpeg.split(',')[1] || '');
  return jpegBytes < pngBytes ? {dataUrl: jpeg, mimeType: 'image/jpeg'} : {dataUrl: png, mimeType: 'image/png'};
}
/** `{dataUrl, mimeType}` resized / re-encoded, or null when the image is fine as it is (or on any failure). */
async function attDownscale(img, mimeType) {
  const mustTranscode = mimeType === 'image/webp';
  const limit = mustTranscode ? Math.min(ATT_MAX_DIMENSION_PX, ATT_WEBP_TRANSCODE_MAX_PX) : ATT_MAX_DIMENSION_PX;
  const width = img.naturalWidth, height = img.naturalHeight;
  if (!width || !height) return null;
  const longest = Math.max(width, height);
  const needsResize = longest > limit;
  if (!needsResize && !mustTranscode) return null;
  const scale = needsResize ? limit / longest : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return attEncodeCanvas(canvas, ctx, mimeType);
}
/** A square, centre-cropped thumbnail as a data: URL (CSP allows data:, not blob:). */
function attThumb(img) {
  const w = img.naturalWidth, h = img.naturalHeight;
  if (!w || !h) return null;
  const side = Math.min(w, h);
  const c = document.createElement('canvas');
  c.width = c.height = ATT_THUMB_PX;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, ATT_THUMB_PX, ATT_THUMB_PX);
  return c.toDataURL('image/png');
}
function attBytesToDataUrl(bytes, mimeType) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error || new Error('read failed'));
    r.readAsDataURL(new Blob([bytes], {type: mimeType || 'application/octet-stream'}));
  });
}
function attDataUrlToBytes(dataUrl) {
  const bin = atob(dataUrl.split(',')[1] || '');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function attRenameFor(name, mimeType) {
  const ext = mimeType === 'image/png' ? '.png' : mimeType === 'image/jpeg' ? '.jpg' : '';
  if (!ext) return name;
  const base = String(name || 'image');
  const dot = base.lastIndexOf('.');
  return (dot > 0 ? base.slice(0, dot) : base) + ext;
}

/* ---------- adding files ---------- */

/** A pending source: `{file}` (drop, paste) or `{path, name, size}` (the open dialog). */
function attAdd(sources, method) {
  let added = 0, skipped = 0;
  for (const src of sources) {
    const name = src.file ? (src.file.name || '') : src.name;
    const size = src.file ? src.file.size : src.size;
    const path = src.path || (src.file && BR && BR.pathForFile ? BR.pathForFile(src.file) : '') || '';
    const key = path || (name + ':' + size + ':' + (src.file && src.file.lastModified || ''));
    if (ATT.items.some((i) => i.key === key && i.status !== 'error')) { skipped++; continue; }
    if (ATT.items.filter((i) => i.status !== 'error').length >= ATT_MAX_ITEMS) {
      toast('Too many attachments', 'Up to ' + ATT_MAX_ITEMS + ' files go with one message', 'bad');
      break;
    }
    const kind = attClassifyName(name);
    const item = {id: 'att' + (++ATT.seq), key, name: name || 'file', size: size || 0, method,
      kind: kind === 'image' ? 'image' : 'document', status: 'preparing', thumb: null, error: '', warn: '', saved: null};
    ATT.items.push(item);
    added++;
    if (kind === 'unsupported' || kind === 'audio') {
      attFail(item, kind === 'audio' ? 'Audio files are not supported yet' : 'This file type is not supported');
      continue;
    }
    attPrepare(item, src).catch(() => attFail(item, 'The file could not be read'));
  }
  if (skipped && !added) toast('Already attached', skipped === 1 ? 'That file is already in this message' : 'Those files are already in this message');
  attRepaint();
}
function attFail(item, error) {
  item.status = 'error';
  item.error = error;
  attRepaint();
}
function attLive(item) { return ATT.items.indexOf(item) >= 0; }

async function attPrepare(item, src) {
  let saveArg;
  if (item.kind === 'image') {
    let bytes;
    if (src.file) bytes = new Uint8Array(await src.file.arrayBuffer());
    else {
      const res = BR && BR.attachReadPicked ? await BR.attachReadPicked(src.path) : null;
      if (!res || !res.ok) return attFail(item, (res && res.error) || 'The file could not be read');
      bytes = res.bytes instanceof Uint8Array ? res.bytes : new Uint8Array(res.bytes);
    }
    let mimeType = attMimeFromName(item.name);
    let name = item.name;
    try {
      const img = await attLoadImage(await attBytesToDataUrl(bytes, mimeType));
      item.thumb = attThumb(img);
      // An animated GIF is sent as it is: re-encoding it keeps one frame.
      const out = mimeType === 'image/gif' ? null : await attDownscale(img, mimeType);
      if (out) { bytes = attDataUrlToBytes(out.dataUrl); mimeType = out.mimeType; name = attRenameFor(name, mimeType); }
    } catch (e) {
      return attFail(item, 'This image could not be opened');
    }
    if (!attLive(item)) return;
    if (bytes.byteLength > ATT_IMAGE_MAX_BYTES) return attFail(item, 'Images can be up to 10 MB; this one is ' + attFormatBytes(bytes.byteLength) + ' even after resizing');
    saveArg = {bytes, name};
  } else if (src.path && !src.file) {
    saveArg = {path: src.path, name: item.name};
  } else {
    if (src.file.size > ATT_DOCUMENT_MAX_BYTES) return attFail(item, 'Files can be up to 20 MB; this one is ' + attFormatBytes(src.file.size));
    saveArg = {bytes: new Uint8Array(await src.file.arrayBuffer()), name: item.name};
  }
  if (!attLive(item)) return;
  const res = BR && BR.attachSave ? await BR.attachSave(saveArg) : {ok: false, error: 'Attachments need a newer app build'};
  if (!attLive(item)) {
    // Removed while it was being saved: its file goes too.
    if (res && res.ok && BR.attachDiscard) BR.attachDiscard(res.path);
    return;
  }
  if (!res || !res.ok) return attFail(item, (res && res.error) || 'The file could not be saved');
  item.saved = {path: res.path, mimeType: res.mimeType, bytes: res.bytes};
  item.kind = res.kind === 'image' ? 'image' : 'document';
  item.size = res.bytes;
  item.status = 'ready';
  if (item.kind === 'image' && attModelSeesImages() === false) item.warn = 'The chosen model may not see images. The agent gets the file and says so if it cannot look at it';
  try { if (typeof ANX !== 'undefined' && ANX.attachmentAdded) ANX.attachmentAdded(item.kind, res.bytes, item.method); } catch (e) { /* never in the way */ }
  attRepaint();
}

function attRemove(id) {
  const item = ATT.items.find((i) => i.id === id);
  if (!item) return;
  ATT.items = ATT.items.filter((i) => i !== item);
  // A chip brought back from a sent message (resend) points at that message's file: it stays.
  if (item.saved && !item.restored && BR && BR.attachDiscard) BR.attachDiscard(item.saved.path);
  attRepaint();
}

/** False only when the catalogue says the composer's model has no vision; null when nobody knows. */
function attModelSeesImages() {
  try {
    const chip = document.querySelector('#composer .cfoot [data-sel-open="model"]');
    const id = chip && chip.getAttribute('data-id');
    if (!id) return null;
    const rows = [].concat((typeof SEL !== 'undefined' && SEL.models) || [], (typeof SEL !== 'undefined' && SEL.local) || []);
    const row = rows.find((m) => m && m.id === id);
    return row && row.supportsVision === false ? false : null;
  } catch (e) { return null; }
}

/* ---------- what submit() asks ---------- */

function attPreparing() { return ATT.items.some((i) => i.status === 'preparing'); }
function attHasReady() { return ATT.items.some((i) => i.status === 'ready'); }
/** The message to send: the caption plus the block, or the caption alone with no file ready. */
function attComposeMessage(caption) {
  const ready = ATT.items.filter((i) => i.status === 'ready');
  if (!ready.length) return caption;
  return attBuildMessage(caption, ready.map((i) => ({path: i.saved.path, mimeType: i.saved.mimeType, bytes: i.saved.bytes})));
}
/** The message went: the chips go (their files stay, the message names them). */
function attClearSent() {
  ATT.items = [];
  ATT.menu = false;
  attRepaint();
}
/**
 * A message coming back to the editor (refused by the local gate, a full
 * queue, resend): its files come back as chips and only its caption goes in
 * the box. Returns the caption, or `text` untouched when it carries no block.
 */
function attToEditor(text) {
  const split = attSplitMessage(text);
  if (!split) return text;
  for (const it of split.items) {
    if (it.failed || ATT.items.some((i) => i.saved && i.saved.path === it.path)) continue;
    ATT.items.push({id: 'att' + (++ATT.seq), key: it.path, name: it.name, size: 0, method: 'restored', restored: true,
      kind: it.kind, status: 'ready', thumb: null, error: '', warn: '', sizeText: it.size,
      saved: {path: it.path, mimeType: it.mimeType, bytes: attParseSize(it.size)}});
  }
  attRepaint();
  return split.caption;
}
function attParseSize(text) {
  const m = /^(\d+(?:\.\d+)?) (B|KB|MB)$/.exec(String(text || ''));
  if (!m) return 0;
  return Math.round(parseFloat(m[1]) * (m[2] === 'MB' ? 1024 * 1024 : m[2] === 'KB' ? 1024 : 1));
}
/** A queued message's tray line: its caption, and how many files ride with it. */
function attQueueLabel(text) {
  const split = attSplitMessage(text);
  if (!split) return text;
  const n = split.items.filter((i) => !i.failed).length;
  return (split.caption ? split.caption + ' · ' : '') + n + (n === 1 ? ' file' : ' files');
}

/* ---------- the composer's markup ---------- */

function attButtonHTML() {
  return '<button class="attbtn' + (ATT.menu ? ' is-open' : '') + '" data-att-menu="1" title="Attach images or files" aria-label="Attach images or files" aria-haspopup="menu" aria-expanded="' + (ATT.menu ? 'true' : 'false') + '">' + ic('plus') + '</button>';
}
/** Hangs off `.composerwrap` (as the slash list does): `.composer` clips. */
function attMenuHTML() {
  return '<div class="attmenu" id="attmenu" role="menu"' + (ATT.menu ? '' : ' hidden') + '>'
    + '<button class="attmenurow" role="menuitem" data-att-pick="images">' + ic('image') + '<span>Images</span></button>'
    + '<button class="attmenurow" role="menuitem" data-att-pick="files">' + ic('file') + '<span>Files</span></button>'
    + '</div>';
}
/** Always emitted (hidden when empty), so attRepaint can swap it without a render(). */
function attStripHTML() {
  const drop = '<div class="attdrop" aria-hidden="true">' + ic('plus') + '<span>Drop files to attach</span></div>';
  if (!ATT.items.length) return '<div class="attstrip" id="attstrip" hidden></div>' + drop;
  return '<div class="attstrip" id="attstrip">' + ATT.items.map(attChipHTML).join('') + '</div>' + drop;
}
function attChipHTML(i) {
  const x = '<button class="attx" data-att-remove="' + i.id + '" aria-label="Remove ' + esc(i.name) + '" title="Remove">' + ic('x') + '</button>';
  const sizeText = i.size ? attFormatBytes(i.size) : (i.sizeText || '');
  if (i.kind === 'image' && i.status !== 'error') {
    const src = i.thumb || (i.saved && attImgCache(i.saved.path));
    const tip = i.name + (sizeText ? ' · ' + sizeText : '') + (i.warn ? ' — ' + i.warn : '');
    return '<div class="attchip is-img' + (i.status === 'preparing' ? ' is-busy' : '') + (i.warn ? ' is-warn' : '') + '" title="' + esc(tip) + '">'
      + (src ? '<img class="attthumb" alt="" src="' + esc(src) + '">'
        : '<span class="attthumb attico"' + (i.saved ? ' data-att-hydrate="' + esc(i.saved.path) + '"' : '') + '>' + ic('image') + '</span>')
      + (i.status === 'preparing' ? '<span class="attspin" aria-label="Preparing"></span>' : '')
      + (i.warn ? '<span class="attwarn" aria-hidden="true">' + ic('alert') + '</span>' : '')
      + x + '</div>';
  }
  const sub = i.status === 'error' ? i.error : i.status === 'preparing' ? 'Preparing…' : sizeText;
  return '<div class="attchip is-doc' + (i.status === 'error' ? ' is-err' : '') + (i.status === 'preparing' ? ' is-busy' : '') + '" title="' + esc(i.name + (sub ? ' · ' + sub : '')) + '">'
    + '<span class="atticon">' + ic(i.status === 'error' ? 'alert' : i.kind === 'image' ? 'image' : 'file') + '</span>'
    + '<span class="attmeta"><span class="attname">' + esc(i.name) + '</span><span class="attsub">' + esc(sub) + '</span></span>'
    + x + '</div>';
}
/** The strip and the send button, in place: a render() here would move the caret. */
function attRepaint() {
  const strip = document.getElementById('attstrip');
  if (strip) {
    const tmp = document.createElement('div');
    tmp.innerHTML = attStripHTML();
    strip.replaceWith(tmp.firstChild);
  }
  const menu = document.getElementById('attmenu');
  if (menu) menu.hidden = !ATT.menu;
  const btn = document.querySelector('#composer .attbtn');
  if (btn) { btn.classList.toggle('is-open', ATT.menu); btn.setAttribute('aria-expanded', ATT.menu ? 'true' : 'false'); }
  if (typeof refreshSend === 'function') refreshSend();
  attPlaceMenu();
}
function attPlaceMenu() {
  const menu = document.getElementById('attmenu');
  const btn = document.querySelector('#composer .attbtn');
  const wrap = menu && menu.parentElement;
  if (!menu || !btn || !wrap || menu.hidden) return;
  const b = btn.getBoundingClientRect(), w = wrap.getBoundingClientRect();
  menu.style.left = Math.max(8, b.left - w.left - 4) + 'px';
}

/* ---------- a user message in the transcript (ATO-406) ---------- */

/** The image data: URLs main has handed back, by path (ATO-408's `imageDataUrl`). */
const ATT_IMG = new Map();
function attImgCache(path) {
  const r = ATT_IMG.get(path);
  return r && r.ok ? r.dataUrl : null;
}
/**
 * The inside of a user turn: the bubble with the caption as typed, and the
 * message's files as chips under it. A message with no block is the bubble
 * alone, exactly as before.
 */
function attUserBody(text) {
  const split = attSplitMessage(text);
  if (!split) return '<div class="prose usr bubble">' + esc(text) + '</div>';
  return (split.caption ? '<div class="prose usr bubble">' + esc(split.caption) + '</div>' : '')
    + '<div class="attsent">' + split.items.map(attSentChipHTML).join('') + '</div>';
}
function attSentChipHTML(it) {
  if (it.failed) {
    return '<span class="attchip is-doc is-gone" title="' + esc(it.name + ': not saved (' + it.reason + ')') + '">'
      + '<span class="atticon">' + ic('alert') + '</span><span class="attmeta"><span class="attname">' + esc(it.name)
      + '</span><span class="attsub">Not attached</span></span></span>';
  }
  const known = ATT_IMG.get(it.path);
  if (known && !known.ok && known.reason === 'missing') return attGoneChipHTML(it);
  if (it.kind === 'image' && !(known && !known.ok)) {
    const src = attImgCache(it.path);
    return '<button class="attchip is-img is-sent" data-att-open="' + esc(it.path) + '" title="' + esc(it.name + ' · ' + it.size) + '" aria-label="Open ' + esc(it.name) + '">'
      + (src ? '<img class="attthumb" alt="" src="' + esc(src) + '">'
        : '<span class="attthumb attico" data-att-hydrate="' + esc(it.path) + '">' + ic('image') + '</span>')
      + '</button>';
  }
  return '<button class="attchip is-doc is-sent" data-att-file="' + esc(it.path) + '" data-att-check="' + esc(it.path) + '" title="' + esc(it.path) + '">'
    + '<span class="atticon">' + ic(it.kind === 'image' ? 'image' : 'file') + '</span>'
    + '<span class="attmeta"><span class="attname">' + esc(it.name) + '</span><span class="attsub">' + esc(it.size) + '</span></span></button>';
}
function attGoneChipHTML(it) {
  return '<span class="attchip is-doc is-gone" title="' + esc(it.path || it.name) + '">'
    + '<span class="atticon">' + ic(it.kind === 'image' ? 'image' : 'file') + '</span>'
    + '<span class="attmeta"><span class="attname">' + esc(it.name) + '</span><span class="attsub">File removed</span></span></span>';
}

/* Thumbnails arrive after the transcript is drawn: anything marked
   `data-att-hydrate` asks main for its image once, and a document chip
   (`data-att-check`) asks once whether its file is still there. Watching the
   DOM keeps this out of render(), which redraws the transcript wholesale. */
const ATT_FILE_STATE = new Map();   // path → 'ok' | 'missing'
function attHydrate(root) {
  const scope = root && root.querySelectorAll ? root : document;
  scope.querySelectorAll('[data-att-hydrate]:not([data-att-asked])').forEach((el) => {
    el.setAttribute('data-att-asked', '1');
    const path = el.getAttribute('data-att-hydrate');
    const known = ATT_IMG.get(path);
    if (known) { attApplyImage(el, path, known); return; }
    if (!(BR && BR.imageDataUrl)) return;   // ATO-408 not in this build: the icon stays
    BR.imageDataUrl(path).then((res) => {
      const r = res && typeof res === 'object' ? res : {ok: false, reason: 'missing'};
      ATT_IMG.set(path, r);
      document.querySelectorAll('[data-att-hydrate]').forEach((node) => {
        if (node.getAttribute('data-att-hydrate') === path) attApplyImage(node, path, r);
      });
    }).catch(() => {});
  });
  scope.querySelectorAll('[data-att-check]:not([data-att-asked])').forEach((el) => {
    el.setAttribute('data-att-asked', '1');
    const path = el.getAttribute('data-att-check');
    const st = ATT_FILE_STATE.get(path);
    if (st) { if (st === 'missing') attMarkGone(el); return; }
    if (!(BR && BR.replyPaths)) return;
    BR.replyPaths([path]).then((res) => {
      const v = res && res.ok && res.files && res.files[0];
      const missing = !!(v && v.why === 'missing');
      ATT_FILE_STATE.set(path, missing ? 'missing' : 'ok');
      if (missing) document.querySelectorAll('[data-att-check]').forEach((node) => { if (node.getAttribute('data-att-check') === path) attMarkGone(node); });
    }).catch(() => {});
  });
}
function attApplyImage(el, path, r) {
  const chip = el.closest('.attchip');
  if (r.ok && r.dataUrl) {
    const img = document.createElement('img');
    img.className = 'attthumb';
    img.alt = '';
    img.src = r.dataUrl;
    el.replaceWith(img);
    return;
  }
  if (r.reason === 'missing' && chip && chip.classList.contains('is-sent')) {
    const name = (chip.getAttribute('title') || '').split(' · ')[0];
    const tmp = document.createElement('div');
    tmp.innerHTML = attGoneChipHTML({path, name, kind: 'image'});
    chip.replaceWith(tmp.firstChild);
  }
  // too-large / outside: the icon tile stays, and a click still opens the file.
}
function attMarkGone(el) {
  const sub = el.querySelector('.attsub');
  if (sub) sub.textContent = 'File removed';
  el.classList.add('is-gone');
  el.removeAttribute('data-att-file');
}
/**
 * A sent image, large. ATO-408 owns the viewer: its global, else an event it
 * can answer, else the file opens in the system's own viewer.
 */
function attOpenViewer(path, name) {
  const dataUrl = attImgCache(path);
  if (typeof window.openImageViewer === 'function') { window.openImageViewer({path, dataUrl, name}); return; }
  const ev = new CustomEvent('atomic:image-open', {detail: {path, dataUrl, name}, cancelable: true});
  if (!document.dispatchEvent(ev)) return;
  attOpenFile(path);
}
function attOpenFile(path) {
  if (!(BR && BR.openReplyPath)) return;
  BR.openReplyPath(path).then((res) => {
    if (res && !res.ok) toast('Could not open the file', res.error || '', 'bad');
  }).catch(() => {});
}

/* ---------- input: the menu, a drop, a paste ---------- */

async function attPick(kind) {
  ATT.menu = false;
  attRepaint();
  if (!(BR && BR.attachPick)) { toast('Attachments need a newer app build', '', 'bad'); return; }
  const list = await BR.attachPick(kind);
  if (Array.isArray(list) && list.length) attAdd(list.map((f) => ({path: f.path, name: f.name, size: f.size || 0})), 'button');
  const e = typeof $ === 'function' ? $('#entry') : null;
  if (e) e.focus();
}
/** True when a drop can attach: the chat's composer is on screen with nothing over it. */
function attCanDrop() {
  if (!document.getElementById('composer')) return false;
  try { if (typeof OB !== 'undefined' && OB.open) return false; } catch (e) { /* no wizard state */ }
  return true;
}
function attDragHasFiles(e) {
  const t = e.dataTransfer && e.dataTransfer.types;
  return !!t && Array.prototype.indexOf.call(t, 'Files') >= 0;
}
function attSetDragging(on) {
  const c = document.getElementById('composer');
  if (c) c.classList.toggle('att-dragging', on);
}

if (typeof document !== 'undefined') {
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    const menuBtn = t.closest('[data-att-menu]');
    if (menuBtn) { e.preventDefault(); ATT.menu = !ATT.menu; attRepaint(); return; }
    const pick = t.closest('[data-att-pick]');
    if (pick) { e.preventDefault(); attPick(pick.getAttribute('data-att-pick')); return; }
    const rm = t.closest('[data-att-remove]');
    if (rm) { e.preventDefault(); attRemove(rm.getAttribute('data-att-remove')); return; }
    const open = t.closest('[data-att-open]');
    if (open) { e.preventDefault(); attOpenViewer(open.getAttribute('data-att-open'), (open.getAttribute('title') || '').split(' · ')[0]); return; }
    const file = t.closest('[data-att-file]');
    if (file) { e.preventDefault(); attOpenFile(file.getAttribute('data-att-file')); return; }
    if (ATT.menu && !t.closest('#attmenu')) { ATT.menu = false; attRepaint(); }
  });
  document.addEventListener('keydown', (e) => {
    if (ATT.menu && e.key === 'Escape') { ATT.menu = false; attRepaint(); e.stopPropagation(); }
  }, true);

  /* A file dropped anywhere on the window. Electron would otherwise open it
     as a page (main also refuses navigation); off the chat it is ignored. */
  document.addEventListener('dragenter', (e) => {
    if (!attDragHasFiles(e)) return;
    e.preventDefault();
    if (!attCanDrop()) return;
    ATT.drag++;
    attSetDragging(true);
  });
  document.addEventListener('dragover', (e) => {
    if (!attDragHasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = attCanDrop() ? 'copy' : 'none';
  });
  document.addEventListener('dragleave', (e) => {
    if (!attDragHasFiles(e)) return;
    ATT.drag = Math.max(0, ATT.drag - 1);
    if (!ATT.drag) attSetDragging(false);
  });
  document.addEventListener('drop', (e) => {
    if (!attDragHasFiles(e)) return;
    e.preventDefault();
    ATT.drag = 0;
    attSetDragging(false);
    if (!attCanDrop()) return;
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    if (files.length) attAdd(files.map((file) => ({file})), 'drop');
  });

  /* ⌘V of an image (or of files copied in Finder) into the message box.
     A pasted image has no path: its bytes go to main. Text pastes as before. */
  document.addEventListener('paste', (e) => {
    if (!e.target || e.target.id !== 'entry' || !e.clipboardData) return;
    const files = Array.from(e.clipboardData.files || []);
    if (!files.length) return;
    e.preventDefault();
    attAdd(files.map((file) => {
      // A screenshot on the clipboard is called `image.png`; say where it came from.
      if (/^image\.(png|jpe?g|gif|webp)$/i.test(file.name || '') || !file.name) {
        const ext = (file.type || 'image/png').split('/')[1].replace('jpeg', 'jpg');
        try { return {file: new File([file], 'pasted-image.' + ext, {type: file.type, lastModified: file.lastModified})}; } catch (err) { return {file}; }
      }
      return {file};
    }), 'paste');
  });

  window.addEventListener('resize', attPlaceMenu);
  // After every transcript or composer redraw: thumbnails and "file removed".
  const startWatch = () => {
    attHydrate(document);
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) attHydrate(n.parentElement || n);
      attPlaceMenu();
    }).observe(document.body, {childList: true, subtree: true});
  };
  if (document.body) startWatch(); else document.addEventListener('DOMContentLoaded', startWatch);
}

if (typeof module !== 'undefined') {
  module.exports = {attClassifyName, attClassifyDroppedPaths, attBuildMessage, attSplitMessage, attFormatBytes,
    attSizeBucket, attDisplayName, attQueueLabel, attParseSize, ATT_HINT_LINE};
}
