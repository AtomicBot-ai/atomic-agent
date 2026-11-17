/* ---------------- ATO-1628: citation chips in a reply ----------------
   Loaded before md-render.js and renderer.js. The agent's `files.search`
   hands the model a ready citation for every hit (the My files contract,
   ATO-1621), a plain markdown link with a `file://` URL and a fragment:

     [report.pdf, p. 12](file:///Users/me/Docs/report.pdf#page=12)
     [call.m4a, 1:23](file:///Users/me/Audio/call.m4a#t=83)

   md-render.js asks citeChipFromLink for such a link and holds the chip it
   gets back, so the reply's later passes (URLs, paths) do not scan inside it.
   A click opens the file in the preview beside the chat (file-preview.js) at
   that page; the chip's Open hands it to its own app (`app:openPath`), as
   ⌘/Ctrl-click does. A file that is gone shows "File not found" in the panel.

   Nothing here reads a file: the preview asks main, which checks the path.
   Paths are only ever written escaped. The pure part is exported for
   test/citation-chip.test.mjs. */

const CITE_PATH_MAX = 4096;

function citeEsc(s) { return String(s).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c])); }

/** `83` → "1:23", `3723` → "1:02:03". */
function citeTimeText(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const pad = (n) => (n < 10 ? '0' : '') + n;
  return h ? h + ':' + pad(m) + ':' + pad(r) : m + ':' + pad(r);
}

function citeBase(path) {
  const parts = String(path || '').split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(path || '');
}

/**
 * A citation link's target, read: `{path, name, page}` or `{path, name, t}`,
 * or null when it is not a `file://` link with `#page=N` or `#t=S`.
 * The path is percent-decoded (RFC 8089); `file:///C:/…` reads as `C:/…`.
 */
function citeParse(href) {
  const s = String(href || '').trim();
  const m = /^file:\/\/(?:localhost)?(\/[^#?]*)(?:\?[^#]*)?#(page|t)=([^&#]*)$/i.exec(s);
  if (!m) return null;
  let path;
  try { path = decodeURIComponent(m[1]); } catch (e) { return null; }
  if (/^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1);
  if (!path || path.length > CITE_PATH_MAX || path.includes('\0') || /(^|[\\/])\.\.([\\/]|$)/.test(path)) return null;
  if (!/^(\/|[A-Za-z]:[\\/])/.test(path) || /[\\/]$/.test(path)) return null;
  const key = m[2].toLowerCase(), raw = m[3];
  const name = citeBase(path);
  if (key === 'page') {
    if (!/^\d{1,6}$/.test(raw) || Number(raw) < 1) return null;
    return {path, name, page: Number(raw)};
  }
  // Media fragments: `t=83`, `t=83.5`, also `t=83,90` (a range: its start).
  const start = raw.split(',')[0];
  if (!/^\d{1,7}(\.\d+)?$/.test(start)) return null;
  return {path, name, t: Math.floor(Number(start))};
}

/** The chip's words: the link's own text, or "name, p. 12" / "name, 1:23" when it has none. */
function citeLabel(cite, text) {
  const own = String(text || '').trim();
  if (own) return own;
  return cite.name + (cite.page ? ', p. ' + cite.page : cite.t !== undefined ? ', ' + citeTimeText(cite.t) : '');
}

function citeChipHtml(cite, text) {
  const icon = typeof ic === 'function' ? ic('doc') : '';
  const openIcon = typeof ic === 'function' ? ic('open') : '';
  const where = cite.page ? 'page ' + cite.page : 'at ' + citeTimeText(cite.t);
  return '<span class="citechip" role="button" tabindex="0" data-cite-path="' + citeEsc(cite.path) + '"'
    + (cite.page ? ' data-cite-page="' + cite.page + '"' : ' data-cite-t="' + cite.t + '"')
    + ' title="' + citeEsc(cite.path + ', ' + where) + '">'
    + icon + '<span class="cite-tx">' + citeEsc(citeLabel(cite, text)) + '</span>'
    + '<span class="cite-open" role="button" tabindex="0" data-cite-open="1" title="Open in its app" aria-label="Open ' + citeEsc(cite.name) + ' in its app">' + openIcon + '</span>'
    + '</span>';
}

/** md-render.js's hook: the chip for a citation link, or '' to leave the link as it was. */
function citeChipFromLink(href, text) {
  const cite = citeParse(href);
  return cite ? citeChipHtml(cite, text) : '';
}

/* ---------------- clicks ---------------- */

function citeNote(title, body) {
  if (typeof toast === 'function') toast(title, body || '', 'bad');
}

function citeOpenOutside(path) {
  const br = typeof window !== 'undefined' ? window.atomic : null;
  if (!br || !br.openPath) return;
  br.openPath(path).then((r) => {
    if (r && r.ok === false) citeNote('File not found', /no such|not found|does not exist|ENOENT/i.test(r.error || '') ? path : (r.error || path));
  }, () => citeNote('Could not open', path));
}

function citeActivate(chip, e) {
  const path = chip.dataset.citePath;
  if (!path) return;
  const outside = (e && (e.metaKey || e.ctrlKey)) || (e && e.target && e.target.closest && e.target.closest('[data-cite-open]'));
  if (outside) { citeOpenOutside(path); return; }
  const page = Number(chip.dataset.citePage) || 0;
  const t = chip.dataset.citeT !== undefined ? Number(chip.dataset.citeT) : null;
  if (typeof filePreviewOpen === 'function' && filePreviewOpen(path, {cite: true, page, t})) return;
  citeOpenOutside(path);
}

if (typeof document !== 'undefined') {
  // Capture phase: the transcript's own click handler (renderer.js) never sees a chip's click.
  document.addEventListener('click', (e) => {
    const chip = e.target && e.target.closest ? e.target.closest('.citechip[data-cite-path]') : null;
    if (!chip) return;
    e.preventDefault(); e.stopPropagation();
    citeActivate(chip, e);
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const chip = e.target && e.target.closest ? e.target.closest('.citechip[data-cite-path]') : null;
    if (!chip) return;
    e.preventDefault(); e.stopPropagation();
    citeActivate(chip, e);
  }, true);
}

if (typeof module !== 'undefined') module.exports = {citeParse, citeTimeText, citeLabel, citeChipHtml, citeChipFromLink, citeBase};
