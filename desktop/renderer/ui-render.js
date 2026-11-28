/* ---------------- ATO-2457: ui.render cards in the chat ----------------
   The agent's `ui.render` tool (core, src/tools/ui) shows a ready
   component: a decision (2-8 buttons), a form, or cards with action
   buttons. Its ok `tool_result` frame carries the checked spec as `ui`.
   This window draws it with its own markup: no iframe, no script of the
   model's, every string escaped. A click (or a sent form) becomes the
   person's next message through widgetDeliver (widget-send.js): into the
   message box, or sent at once when "Widgets send right away" is on.

   The card's box is `data-morph-keep`, so a repaint of the transcript
   leaves what the person typed and chose; the values are also kept here
   (UIR), so a chat drawn again from scratch shows them. Like a canvas,
   a card lives in the live stream only: the store keeps no `details`.

   Precedents: OpenClaw show-widget and Claude's interactive widgets
   (a click is the next prompt), ChatGPT Apps' inline cards.

   Loaded after chat-artifact.js and before renderer.js; only declares.
   ui-render-act.js reads the clicks. Pure parts exported for
   test/ui-render.test.mjs. */

const UIR_KINDS = ['decision', 'form', 'cards'];
const UIR_FIELD_TYPES = ['text', 'textarea', 'number', 'select', 'checkbox', 'date'];
/* key → {key, spec, values: {name: string}, chosen: index|-1, sent: '' (what went), err: ''}. */
const UIR = new Map();
let UIR_SEQ = 0;

function uirEsc(s) { return String(s).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c])); }
function uirStr(v, max) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }

/** The `ui` an ok ui.render frame carries, checked again (the window trusts no frame): a spec or null. */
function uiSpecFromToolResult(p) {
  if (!p || typeof p !== 'object' || p.tool !== 'ui.render' || (p.status != null && p.status !== 'ok')) return null;
  const u = p.ui;
  if (!u || typeof u !== 'object' || !UIR_KINDS.includes(u.kind)) return null;
  const title = uirStr(u.title, 200);
  if (!title) return null;
  const spec = {kind: u.kind, title, text: uirStr(u.text, 2000)};
  if (u.kind === 'decision') {
    spec.options = (Array.isArray(u.options) ? u.options : []).slice(0, 8)
      .map((o) => ({label: uirStr(o && o.label, 120), description: uirStr(o && o.description, 300), message: uirStr(o && o.message, 2000)}))
      .filter((o) => o.label);
    if (spec.options.length < 2) return null;
  } else if (u.kind === 'form') {
    spec.submit = uirStr(u.submit, 120) || 'Send';
    spec.fields = (Array.isArray(u.fields) ? u.fields : []).slice(0, 12).map((f) => ({
      name: uirStr(f && f.name, 40), label: uirStr(f && f.label, 120),
      type: UIR_FIELD_TYPES.includes(f && f.type) ? f.type : 'text',
      options: Array.isArray(f && f.options) ? f.options.slice(0, 20).map((x) => uirStr(x, 120)).filter(Boolean) : [],
      placeholder: uirStr(f && f.placeholder, 120), required: !!(f && f.required === true), value: uirStr(f && f.value, 2000),
    })).filter((f) => f.name && f.label && (f.type !== 'select' || f.options.length));
    if (!spec.fields.length) return null;
  } else {
    spec.cards = (Array.isArray(u.cards) ? u.cards : []).slice(0, 12).map((c) => {
      const a = c && c.action && typeof c.action === 'object' ? {label: uirStr(c.action.label, 120), message: uirStr(c.action.message, 2000)} : null;
      return {title: uirStr(c && c.title, 120), text: uirStr(c && c.text, 2000), meta: uirStr(c && c.meta, 120), action: a && a.label ? a : null};
    }).filter((c) => c.title);
    if (!spec.cards.length) return null;
  }
  return spec;
}

/** A form's starting values: what each field holds before the person types. */
function uirStartValues(spec) {
  const v = {};
  for (const f of spec.fields || []) v[f.name] = f.type === 'checkbox' ? (f.value === 'true' ? 'true' : 'false') : (f.value || '');
  return v;
}

/** An ok ui.render call into the reply `item`: its card, drawn in the reply. False when the frame has none. */
function chatUiRender(item, payload) {
  const spec = uiSpecFromToolResult(payload);
  if (!item || !spec) return false;
  const key = 'ui' + (++UIR_SEQ) + '-' + Date.now().toString(36);
  UIR.set(key, {key, spec, values: uirStartValues(spec), chosen: -1, sent: '', err: ''});
  if (!Array.isArray(item.uiCards)) item.uiCards = [];
  item.uiCards.push(key);
  return true;
}

/* ---------- the message a click sends ---------- */

/** What a decision's option, a card's action or a sent form puts in the box. '' when there is nothing to send. */
function uirMessage(st, what) {
  const s = st.spec;
  if (s.kind === 'decision') {
    const o = s.options[what];
    return o ? (o.message || o.label) : '';
  }
  if (s.kind === 'cards') {
    const c = s.cards[what];
    return c && c.action ? (c.action.message || c.action.label + ': ' + c.title) : '';
  }
  const lines = [s.title];
  for (const f of s.fields) {
    const v = String(st.values[f.name] == null ? '' : st.values[f.name]).trim();
    if (f.type === 'checkbox') lines.push(f.label + ': ' + (v === 'true' ? 'yes' : 'no'));
    else if (v) lines.push(f.label + ': ' + v);
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

/** The labels of a form's required fields that are still empty. */
function uirMissing(st) {
  return (st.spec.fields || []).filter((f) => f.required && f.type !== 'checkbox' && !String(st.values[f.name] || '').trim()).map((f) => f.label);
}

/* ---------- the card ---------- */

function uirFieldHTML(st, f, i) {
  const e = uirEsc;
  const id = 'uir-' + st.key + '-' + i;
  const v = st.values[f.name] == null ? '' : String(st.values[f.name]);
  const common = ' id="' + id + '" data-uir-field="' + e(f.name) + '"' + (f.required ? ' aria-required="true"' : '');
  const ph = f.placeholder ? ' placeholder="' + e(f.placeholder) + '"' : '';
  let input;
  if (f.type === 'textarea') input = '<textarea class="tk-inp uir-in" rows="3"' + common + ph + '>' + e(v) + '</textarea>';
  else if (f.type === 'select') {
    input = '<select class="tk-inp uir-in"' + common + '>' + (v ? '' : '<option value="" selected>Choose…</option>')
      + f.options.map((o) => '<option value="' + e(o) + '"' + (o === v ? ' selected' : '') + '>' + e(o) + '</option>').join('') + '</select>';
  } else if (f.type === 'checkbox') {
    return '<label class="uir-check" for="' + id + '"><input type="checkbox"' + common + (v === 'true' ? ' checked' : '') + '><span>' + e(f.label) + '</span></label>';
  } else input = '<input class="tk-inp uir-in" type="' + f.type + '"' + common + ph + ' value="' + e(v) + '">';
  return '<label class="uir-field" for="' + id + '"><span class="uir-label">' + e(f.label) + (f.required ? ' <span class="uir-req" aria-hidden="true">*</span>' : '') + '</span>' + input + '</label>';
}

/** The inside of a card's box: everything the person sees and clicks. */
function uirBodyHTML(st) {
  const e = uirEsc;
  const s = st.spec;
  let body = '<div class="uir-head"><div class="uir-title">' + e(s.title) + '</div>'
    + '<button class="uir-png" data-uirpng="' + e(st.key) + '" title="Save the card as a PNG picture" aria-label="Save as PNG">'
    + (typeof ic === 'function' ? ic('download') : 'PNG') + '</button></div>'   // artifact-png.js
    + (s.text ? '<div class="uir-text">' + e(s.text) + '</div>' : '');
  if (s.kind === 'decision') {
    body += '<div class="uir-opts" role="group" aria-label="' + e(s.title) + '">' + s.options.map((o, i) =>
      '<button class="uir-opt' + (st.chosen === i ? ' on' : '') + '" data-uir-opt="' + i + '" aria-pressed="' + (st.chosen === i) + '">'
      + '<span class="t">' + e(o.label) + '</span>' + (o.description ? '<span class="d">' + e(o.description) + '</span>' : '') + '</button>').join('') + '</div>';
  } else if (s.kind === 'form') {
    body += '<div class="uir-form">' + s.fields.map((f, i) => uirFieldHTML(st, f, i)).join('') + '</div>'
      + '<div class="uir-foot"><button class="btn btn-p sm" data-uir-submit="1">' + e(s.submit) + '</button></div>';
  } else {
    body += '<div class="uir-cards">' + s.cards.map((c, i) =>
      '<div class="uir-card' + (st.chosen === i ? ' on' : '') + '"><div class="t">' + e(c.title) + '</div>'
      + (c.meta ? '<div class="m">' + e(c.meta) + '</div>' : '') + (c.text ? '<div class="d">' + e(c.text) + '</div>' : '')
      + (c.action ? '<button class="btn btn-s sm" data-uir-card="' + i + '">' + e(c.action.label) + '</button>' : '') + '</div>').join('') + '</div>';
  }
  return body + '<div class="uir-note" role="status"' + (st.err ? ' data-bad="1"' : '') + '>' + e(st.err || st.sent) + '</div>';
}

/** The boxes for a reply's ui.render cards, in order. */
function uiRenderSlots(m) {
  const out = [];
  for (const key of (m && Array.isArray(m.uiCards) ? m.uiCards : [])) {
    const st = UIR.get(key);
    if (!st) continue;
    out.push('<div class="uir uir-' + st.spec.kind + '" data-uir="' + uirEsc(key) + '" data-morph-keep="uir:' + uirEsc(key) + '">' + uirBodyHTML(st) + '</div>');
  }
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {UIR, uiSpecFromToolResult, uirStartValues, chatUiRender, uirMessage, uirMissing, uirBodyHTML, uiRenderSlots, uirEsc};
}
