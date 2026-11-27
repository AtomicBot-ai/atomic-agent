/* ---------------- ATO-2444: a deck's slides, small, while os.fs.write_pptx builds it ----------------
   Loaded before renderer.js; declares only. Shared with the Node checks
   (test/slide-thumbs.test.mjs). Nothing here touches the DOM.

   An agent with ATO-2444 sends one `tool_update` per slide it lays out, with
   `slide: {index, count, layout, title, subtitle?, bullets, visual?, moved,
   theme, accent?}` (the text already clipped by the agent). The running
   os.fs.write_pptx card keeps them (`card.slides`, by index) and draws a
   strip of thumbnails under its head: the deck's theme colours, the layout's
   shape (a big figure, a quote, two columns, a timeline, a box where the
   picture, table or chart goes) and the slide's own words. The slides come
   before the approval card, so the person sees the deck they are asked about.

   These are sketches of the layout, like the preview panel's text cards
   (office-preview.js): the file itself, drawn by LibreOffice or Quick Look,
   is a click on the file chip once it is written. An older agent sends no
   `slide`: no strip, the card reads as before. A reopened chat has no strip
   either (the store keeps no progress). */

const SLIDE_THUMBS_MAX = 200;
const SLIDE_THEMES = {
  light: {bg: '#FFFFFF', title: '#1F2937', text: '#374151', accent: '#2F6FEB', muted: '#6B7280'},
  dark: {bg: '#111827', title: '#F9FAFB', text: '#E5E7EB', accent: '#60A5FA', muted: '#9CA3AF'},
  blue: {bg: '#0B3D91', title: '#FFFFFF', text: '#E0EAFF', accent: '#FFC857', muted: '#B9CCF5'},
  warm: {bg: '#FFF8F0', title: '#3D2C29', text: '#4A3B37', accent: '#D9480F', muted: '#8A7A74'},
};
const SLIDE_VISUAL_WORD = {image: 'Picture', table: 'Table', chart: 'Chart'};

function slideThumbText(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/** A frame's `slide`, checked: the shape the strip draws, or null. */
function slideOfUpdate(payload) {
  const s = payload && typeof payload === 'object' ? payload.slide : null;
  if (!s || typeof s !== 'object') return null;
  const index = Number(s.index);
  const count = Number(s.count);
  if (!Number.isInteger(index) || !Number.isInteger(count) || index < 0 || count < 1 || index >= count) return null;
  const title = slideThumbText(s.title, 120);
  if (!title) return null;
  const visual = s.visual === 'image' || s.visual === 'table' || s.visual === 'chart' ? s.visual : '';
  const accent = typeof s.accent === 'string' && /^[0-9A-Fa-f]{6}$/.test(s.accent) ? '#' + s.accent : '';
  return {
    index, count, title,
    layout: typeof s.layout === 'string' && /^[a-z-]{1,24}$/.test(s.layout) ? s.layout : 'bullets',
    subtitle: slideThumbText(s.subtitle, 120),
    bullets: (Array.isArray(s.bullets) ? s.bullets : []).slice(0, 6).map((b) => slideThumbText(b, 120)).filter(Boolean),
    visual,
    moved: Number.isInteger(s.moved) && s.moved > 0 ? s.moved : 0,
    theme: Object.prototype.hasOwnProperty.call(SLIDE_THEMES, s.theme) ? s.theme : 'light',
    accent,
  };
}

/** Keeps one `tool_update`'s slide on the card; true when it had one. The same index again replaces it. */
function slideThumbsAdd(card, payload) {
  const s = slideOfUpdate(payload);
  if (!card || !s || s.index >= SLIDE_THUMBS_MAX) return false;
  const list = Array.isArray(card.slides) ? card.slides.slice() : [];
  list[s.index] = s;
  card.slides = list;
  card.slideCount = s.count;
  return true;
}

function slideThumbBullets(lines, esc, cls) {
  return lines.map((b) => {
    const sub = /^ {2,}/.test(b);
    return '<div class="' + cls + (sub ? ' st-sub' : '') + '">' + esc(b.trim()) + '</div>';
  }).join('');
}

/** The inside of one thumbnail: the layout's shape with the slide's words. */
function slideThumbBody(s, esc) {
  const t = '<div class="st-title">' + esc(s.title) + '</div>';
  const sub = s.subtitle ? '<div class="st-subtitle">' + esc(s.subtitle) + '</div>' : '';
  const lines = slideThumbBullets(s.bullets, esc, 'st-b');
  const box = s.visual ? '<div class="st-visual">' + esc(SLIDE_VISUAL_WORD[s.visual]) + '</div>' : '';
  switch (s.layout) {
    case 'title': return '<div class="st-center">' + t + sub + '</div>';
    case 'section': return '<div class="st-section"><i class="st-bar"></i><div>' + t + sub + '</div></div>';
    case 'quote': return '<div class="st-center st-quote">' + t + sub + '</div>';
    case 'big-number': return '<div class="st-center st-big">' + t + sub + lines + '</div>';
    case 'image-full': return t + '<i class="st-rule"></i>' + box + sub;
    case 'chart': return t + '<i class="st-rule"></i><div class="st-row"><div class="st-wide">' + box + '</div><div>' + sub + lines + '</div></div>';
    case 'table': return t + '<i class="st-rule"></i>' + box + sub + lines;
    case 'two-column':
    case 'comparison': {
      const second = s.layout === 'comparison' ? s.bullets.findIndex((b, i) => i > 0 && !/^ {2,}/.test(b)) : Math.ceil(s.bullets.length / 2);
      // A comparison clipped before its second heading (an agent that sent only the first lines) splits at the middle, never one empty side.
      const at = second > 0 ? second : Math.ceil(s.bullets.length / 2);
      const col = (part) => '<div>' + slideThumbBullets(part, esc, 'st-b') + '</div>';
      return t + '<i class="st-rule"></i>' + sub + '<div class="st-row st-cols">' + col(s.bullets.slice(0, at)) + col(s.bullets.slice(at)) + '</div>';
    }
    case 'timeline':
      return t + '<i class="st-rule"></i>' + sub + '<div class="st-line">' + s.bullets.map((b) => '<div class="st-step"><i></i><span>' + esc(b.trim()) + '</span></div>').join('') + '</div>';
    default:
      return t + '<i class="st-rule"></i>' + (box ? '<div class="st-row"><div>' + sub + lines + '</div><div>' + box + '</div></div>' : sub + lines);
  }
}

function slideThumbHTML(s, esc) {
  const c = SLIDE_THEMES[s.theme];
  const style = '--st-bg:' + c.bg + ';--st-title:' + c.title + ';--st-text:' + c.text + ';--st-accent:' + (s.accent || c.accent) + ';--st-muted:' + c.muted;
  const moved = s.moved ? s.moved + ' point' + (s.moved === 1 ? '' : 's') + ' moved to the speaker notes' : '';
  const label = 'Slide ' + (s.index + 1) + ': ' + s.title + (moved ? '. ' + moved : '');
  return '<figure class="st-thumb st-' + esc(s.layout) + '" style="' + style + '" title="' + esc(label) + '" aria-label="' + esc(label) + '">'
    + '<div class="st-slide">' + slideThumbBody(s, esc) + '</div>'
    + '<figcaption class="tnum">' + (s.index + 1) + (moved ? ' <span class="st-moved">notes</span>' : '') + '</figcaption></figure>';
}

/** The strip under a deck's card: '' for a card with no slides (another tool, an older agent). */
function slideThumbsHTML(card, esc) {
  if (!card || card.ok === false || !Array.isArray(card.slides)) return '';
  const e = typeof esc === 'function' ? esc : (s) => String(s);
  const shown = card.slides.filter(Boolean);
  if (!shown.length) return '';
  const total = card.slideCount || shown.length;
  const head = card.ok === true
    ? total + ' slide' + (total === 1 ? '' : 's')
    : 'Laid out ' + shown.length + ' of ' + total + ' slide' + (total === 1 ? '' : 's');
  return '<div class="st-strip" role="group" aria-label="Slides of this deck">'
    + '<div class="st-head tnum" role="status">' + e(head) + '</div>'
    + '<div class="st-list">' + shown.map((s) => slideThumbHTML(s, e)).join('') + '</div></div>';
}

if (typeof module !== 'undefined') module.exports = {slideOfUpdate, slideThumbsAdd, slideThumbsHTML, SLIDE_THEMES, SLIDE_THUMBS_MAX};
