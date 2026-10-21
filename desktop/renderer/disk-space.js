/* ---------------- ATO-507: room on the disk for a model download ----------------
   Loaded before renderer.js; declares only. Shared by the renderer and the
   Node checks (test/disk-space.test.mjs).

   A local model is 5–26 GB. A pull that runs out of room used to fail only
   when the engine started, an hour later, with a disk error
   (main/engine-failure.ts). Every place a download starts — the wizard's
   "Download 19.7 GB", Settings › Models, the Hugging Face add, the
   composer's picker — now checks the model's size, plus a margin, against
   the free space main measured on the models disk (main/disk-space.ts,
   `app:diskSpace`), and says "Needs 19.7 GB, 12.1 GB free on this disk."
   instead of offering a download that cannot finish.

   When the free space is not known (no answer yet, or main could not read
   it) nothing is blocked and nothing is said: a missing reading must never
   stand between someone and a model. The reading is cached: read again when
   a screen that downloads opens (diskSpaceRefresh(br, true)) and at most
   every DISK_STALE_MS otherwise, never once per paint. */

const DISK_GIB = 1024 * 1024 * 1024;
/* Room beyond the file itself: the partial file, the projector, logs. */
const DISK_MARGIN = 0.1;
const DISK_STALE_MS = 30 * 1000;

/* A size in bytes, from what the catalogue and the bridge carry: a number is
   bytes; a string reads like the catalogue writes it ("19.7 GB", "635 MB",
   "1.2 TiB"), and a bare number in a string is the curated catalogue's GB
   (renderer.js sizeStringGb). Units are binary, as sizeStringGb reads them,
   so the wizard's "19.7 GB" and this line's agree. 0 when it says nothing. */
function diskSizeBytes(size) {
  if (typeof size === 'number') return Number.isFinite(size) && size > 0 ? size : 0;
  const m = /^\s*([\d.]+)\s*([KMGT]?)i?B?\s*$/i.exec(String(size == null ? '' : size));
  const n = m ? parseFloat(m[1]) : NaN;
  if (!Number.isFinite(n) || n <= 0) return 0;
  const unit = m[2].toUpperCase();
  const k = unit === 'K' ? 1024 : unit === 'M' ? 1024 ** 2 : unit === 'T' ? 1024 ** 4 : DISK_GIB;
  return n * k;
}

/* "19.7 GB", rounded as the wizard's button rounds (obGbWord). `down` floors
   instead, so free space is never said to be more than it is. */
function diskGbWord(bytes, down) {
  const tenths = (Number(bytes) || 0) / DISK_GIB * 10;
  const gb = (down ? Math.floor(tenths) : Math.round(tenths)) / 10;
  return gb.toFixed(1).replace(/\.0$/, '') + ' GB';
}

/* Whether a download of `need` (bytes, or a size string; `extra` the same,
   e.g. a vision model's projector) fits in `space` ({freeBytes} as main
   answers, or null). {ok:true} when it fits, when the size is not known, or
   when the free space is not; else {ok:false, needBytes, freeBytes, text}.
   It fits when size × (1 + margin) is free. */
function diskFit(need, space, extra, margin) {
  const needBytes = diskSizeBytes(need) + diskSizeBytes(extra);
  const free = space && typeof space === 'object' ? Number(space.freeBytes) : NaN;
  if (!(needBytes > 0) || !Number.isFinite(free) || free < 0) return {ok: true};
  const m = typeof margin === 'number' && margin >= 0 ? margin : DISK_MARGIN;
  if (free >= needBytes * (1 + m)) return {ok: true};
  // The file itself would fit, the room around it would not: say why the numbers look close.
  const text = 'Needs ' + diskGbWord(needBytes) + (free >= needBytes ? ' and some room to spare' : '')
    + ', ' + diskGbWord(free, true) + ' free on this disk.';
  return {ok: false, needBytes, freeBytes: free, text};
}

/* The cached reading: `space` is main's last answer (null = unknown), `at`
   when it came, `pending` the read in flight. `onChange` is the renderer's
   repaint, called when a new reading changes what can be said. */
const DISK = {space: null, at: 0, pending: null, onChange: null};

/* Read again when `force` (a screen that downloads just opened) or when the
   reading is older than DISK_STALE_MS. One read at a time. Resolves to the
   reading; never rejects. `br` is the preload bridge. */
function diskSpaceRefresh(br, force, now) {
  const t = typeof now === 'number' ? now : Date.now();
  if (DISK.pending) return DISK.pending;
  if (!force && DISK.at && t - DISK.at < DISK_STALE_MS) return Promise.resolve(DISK.space);
  if (!br || typeof br.diskSpace !== 'function') return Promise.resolve(DISK.space);
  DISK.at = t;
  DISK.pending = Promise.resolve().then(() => br.diskSpace()).then((res) => {
    const next = res && Number.isFinite(Number(res.freeBytes)) ? {freeBytes: Number(res.freeBytes), totalBytes: Number(res.totalBytes) || 0, path: String(res.path || '')} : null;
    const was = DISK.space;
    DISK.space = next;
    // A repaint only when it could change a verdict: known/unknown, or 100 MB either way.
    const moved = !was !== !next || (was && next && Math.abs(was.freeBytes - next.freeBytes) >= 100 * 1024 * 1024);
    if (moved && typeof DISK.onChange === 'function') DISK.onChange();
    return next;
  }, () => DISK.space).finally(() => { DISK.pending = null; });
  return DISK.pending;
}

/* The reading for a paint: what is cached, with a read started behind it
   when that is stale. */
function diskSpaceNow(br) {
  diskSpaceRefresh(br, false);
  return DISK.space;
}

if (typeof module !== 'undefined') module.exports = {DISK_GIB, DISK_MARGIN, DISK_STALE_MS, DISK, diskSizeBytes, diskGbWord, diskFit, diskSpaceRefresh, diskSpaceNow};
