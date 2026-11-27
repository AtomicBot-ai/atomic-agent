/* ---------------- ATO-981: a Word, PowerPoint or Excel file in the preview panel ----------------
   Loaded before file-preview.js, whose fpBodyHtml hands an "office" preview
   here. main (main/office-preview.ts) has already pulled the text out of the
   file; this only draws it, every string escaped:
   - a deck as numbered cards, one per slide: its title, then its paragraphs;
   - a document as its paragraphs, headings as headings;
   - a workbook's first sheet as a table (the CSV preview's table classes),
     with column letters and row numbers as Excel shows them, and the names
     of the other sheets.
   It is the text, not the layout: Open shows the real thing. When main cut
   the file short (too many slides, rows or characters) a note says so.

   ATO-2410: a deck's cards are the fallback. When main says the machine can
   draw the slides (`office.renderable`), file-preview.js asks it for the
   pictures and puts the answer on `office.render`: a PDF (LibreOffice), shown
   in the same frame as a .pdf file, or Quick Look's HTML page, shown in the
   same sandboxed frame as an .html file (ofSlidesDoc adds the CSP and a zoom
   that fits the page to the panel). Until it answers the cards carry a
   "Drawing the slides" note; when it cannot (`office.renderFailed`) they stay.

   Shared with the Node checks (test/office-preview.test.mjs): fpOfficeHtml,
   ofSlidesDoc. Nothing here touches the DOM. */

function ofEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c])); }

/** "A", "B", … "Z", "AA": a zero-based column's letters. */
function ofColName(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function ofNote(text) { return '<div class="fp-note">' + ofEsc(text) + '</div>'; }

/** The deck's slides as pictures when main drew them (ATO-2410), else null. file-preview.js fills the frame in. */
function ofSlidesFrameHtml(o, name) {
  const r = o && o.render;
  if (!r || !r.ok) return null;
  if (r.kind === 'pdf' && typeof r.base64 === 'string' && r.base64) return '<iframe class="fp-frame fp-pdf" data-fp-pdf="1" title="' + ofEsc(name) + '"></iframe>';
  if (r.kind === 'html' && typeof r.html === 'string' && r.html) return '<iframe class="fp-frame fp-slides" data-fp-slides="1" sandbox="" referrerpolicy="no-referrer" title="' + ofEsc(name) + '"></iframe>';
  return null;
}

/**
 * The document Quick Look's page is shown as (ATO-2410): the page itself
 * after a CSP that allows no script, no network, no frames (the .html
 * preview's), and a zoom that fits its fixed width to the panel. No doctype
 * on purpose: Quick Look measures in unitless CSS lengths (`top:37;
 * width:720`), which only quirks mode honours; a doctype would pile every
 * slide's text into one corner.
 */
function ofSlidesDoc(html, csp, zoom) {
  const z = zoom > 0 && zoom < 1 ? Math.round(zoom * 1000) / 1000 : 1;
  const head = '<meta http-equiv="Content-Security-Policy" content="' + csp + '"><meta charset="utf-8">'
    + '<style>html,body{margin:0;padding:0 0 8px}body{zoom:' + z + '}</style>';
  const s = String(html == null ? '' : html);
  const open = s.search(/<head(\s[^>]*)?>/i);
  if (open < 0) return head + s;
  const end = s.indexOf('>', open) + 1;
  return s.slice(0, end) + head + s.slice(end);
}

function ofSlidesHtml(o, name) {
  const frame = ofSlidesFrameHtml(o, name);
  if (frame) return frame;
  const slides = Array.isArray(o.slides) ? o.slides : [];
  if (!slides.length) return '<div class="fp-msg">This presentation has no slides.</div>';
  const cut = o.truncated ? ofNote('Showing ' + slides.length + ' of ' + (o.total || slides.length) + ' slides. Open the file to see all of it.') : '';
  const wait = o.renderable && !o.renderFailed ? '<div class="fp-note fp-wait">Drawing the slides…</div>' : '';
  return cut + wait + '<div class="fp-office fp-deck">' + slides.map((s) => {
    const paras = (Array.isArray(s.paras) ? s.paras : []).map((p) => '<p>' + ofEsc(p) + '</p>').join('');
    return '<section class="fp-slide"><div class="fp-slide-n">' + ofEsc(s.n) + '</div><div class="fp-slide-c">'
      + (s.title ? '<div class="fp-slide-t">' + ofEsc(s.title) + '</div>' : '')
      + (paras || (s.title ? '' : '<p class="fp-slide-e">No text on this slide.</p>'))
      + '</div></section>';
  }).join('') + '</div>';
}

function ofDocHtml(o) {
  const paras = Array.isArray(o.paras) ? o.paras : [];
  if (!paras.length) return '<div class="fp-msg">This document has no text.</div>';
  const body = paras.map((p) => {
    const h = p.heading >= 1 && p.heading <= 6 ? Math.min(4, p.heading + 1) : 0;   // h2..h4: the panel's own title is above
    return h ? '<h' + h + '>' + ofEsc(p.text) + '</h' + h + '>' : '<p>' + ofEsc(p.text) + '</p>';
  }).join('');
  return (o.truncated ? ofNote('Showing the start of the document. Open the file to read on.') : '')
    + '<div class="prose fp-prose fp-office fp-doc">' + body + '</div>';
}

function ofSheetHtml(o) {
  const rows = Array.isArray(o.rows) ? o.rows : [];
  const sheets = Array.isArray(o.sheets) ? o.sheets : [];
  const which = sheets.length > 1
    ? '<div class="fp-sheets">Sheet <b>' + ofEsc(o.sheet) + '</b> of ' + sheets.length + ': ' + sheets.map(ofEsc).join(', ') + '</div>'
    : '';
  if (!rows.length) return which + '<div class="fp-msg">This sheet is empty.</div>';
  const cols = rows.reduce((w, r) => Math.max(w, Array.isArray(r) ? r.length : 0), 0);
  const head = '<tr><th></th>' + Array.from({length: cols}, (_, i) => '<th>' + ofColName(i) + '</th>').join('') + '</tr>';
  const body = rows.map((r, k) => '<tr><th class="fp-rown">' + (k + 1) + '</th>'
    + Array.from({length: cols}, (_, i) => '<td>' + ofEsc(Array.isArray(r) ? r[i] : '') + '</td>').join('') + '</tr>').join('');
  return (o.truncated ? ofNote('Showing the top-left of the sheet. Open the file to see all of it.') : '') + which
    + '<div class="prose fp-prose"><div class="mdtbl fp-tbl"><table><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div></div>';
}

/** The panel's body for a preview of kind "office". */
function fpOfficeHtml(d) {
  const o = d && d.office;
  if (!o) return '<div class="fp-msg">This file could not be read.</div>';
  if (o.type === 'pptx') return ofSlidesHtml(o, d.name || 'Slides');
  if (o.type === 'docx') return ofDocHtml(o);
  if (o.type === 'xlsx') return ofSheetHtml(o);
  return '<div class="fp-msg">This file could not be read.</div>';
}

if (typeof module !== 'undefined') module.exports = {fpOfficeHtml, ofColName, ofSlidesDoc};
