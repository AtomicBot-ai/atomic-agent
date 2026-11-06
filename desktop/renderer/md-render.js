/* ---------------- ATO-664 / ATO-1251: a reply's markdown, as blocks ----------------
   Loaded before renderer.js, after vendor/marked.js; declares only. Shared by
   the renderer (renderMarkdown hands its text here) and the Node checks
   (test/md-render.test.mjs).

   Parsing is marked's (vendored, the same version the agent's TUI uses), so
   nesting, emphasis, links, numbering and code follow CommonMark + GFM rather
   than a set of regexes. Drawing is this file's: it walks marked's tokens and
   writes the window's own blocks. Nothing new is asked of the model: a
   checklist is `- [ ]`, a callout is GitHub's `> [!NOTE]` or a `**Note:**`
   lead, key/value pairs are lines of `**Key:** value`, a comparison is a
   "Pros" list next to a "Cons" list, a card is a link or URL alone on its
   line, a footnote is `[^1]` with its `[^1]: text` line.

   The contract with renderProseFresh:
   - input is the model's RAW text; every piece of it that reaches the output
     is escaped here, and only tags of this file's own are written, so nothing
     the model writes can become markup (raw HTML is shown as text). The
     finished reply also goes through DOMPurify (mdSanitize) as a second wall;
   - code (fences and spans) is held out as \u0000N\u0000 placeholders and NOT
     put back here: renderProseFresh runs its link and file-chip passes first
     and restores them last, so a path inside code never becomes a chip. Links
     made here are held the same way, so those passes never rewrite a URL
     inside an attribute;
   - blocks are joined by newlines, which `.prose`'s pre-wrap keeps as line
     breaks; each block piece is one line of markup.
   ----------------------------------------------------------------------- */

const MDR_MAX_DEPTH = 4;
const MDR_CALLOUT = {
  note: 'note', info: 'note', 'heads up': 'note', 'fyi': 'note', 'примечание': 'note', 'заметка': 'note', 'к сведению': 'note',
  tip: 'tip', hint: 'tip', 'совет': 'tip', 'подсказка': 'tip',
  important: 'important', 'важно': 'important',
  warning: 'warning', warn: 'warning', attention: 'warning', 'внимание': 'warning', 'предупреждение': 'warning',
  caution: 'caution', danger: 'caution', 'осторожно': 'caution', 'опасно': 'caution',
};
const MDR_CALLOUT_TITLE = {note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution'};
const MDR_EMOJI_CALLOUT = {'⚠️': 'warning', '⚠': 'warning', '❗': 'important', '❗️': 'important', 'ℹ️': 'note', 'ℹ': 'note', '💡': 'tip', '🚨': 'caution', '⛔': 'caution', '⛔️': 'caution'};
const MDR_PROS = /^(?:#{1,6}\s+)?(?:\*\*)?\s*(?:✅\s*)?(pros|advantages|benefits|strengths|плюсы|преимущества|достоинства)\s*:?\s*(?:\*\*)?\s*:?$/i;
const MDR_CONS = /^(?:#{1,6}\s+)?(?:\*\*)?\s*(?:❌\s*)?(cons|disadvantages|drawbacks|weaknesses|минусы|недостатки)\s*:?\s*(?:\*\*)?\s*:?$/i;
const MDR_URL_LINE = /^(?:https?:\/\/|www\.)[^\s<>"']+$/;
const MDR_PATH_LINE = /^(?:~\/|\/|[A-Za-z]:[\\/])[^\s]*[^\s\/\\]\.[A-Za-z0-9]{1,10}$/;
const MDR_FN_DEF = /^\[\^([^\]\s]{1,40})\]:[ \t]*(.*)$/;
const MDR_FN_REF = /\[\^([^\]\s]{1,40})\]/g;

function mdrEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
}
function mdrHold(held, html) { return '\u0000' + (held.push(html) - 1) + '\u0000'; }
function mdrNl(s) { return (String(s || '').match(/\n/g) || []).length; }
function mdrTrailNl(s) { return (/\n*$/.exec(String(s || '')) || [''])[0].length; }

/* One marked instance for the window. Setext headings are off: a model's
   `---` under a line of text is a rule (ATO-163's T53 pins it), and with them
   on, every streamed "text\n-" frame flashed as a heading. */
let MDR_MD = null;
function mdrMarked() {
  if (MDR_MD) return MDR_MD;
  const lib = typeof marked !== 'undefined' ? marked : null;
  if (!lib || typeof lib.Marked !== 'function') return null;
  const m = new lib.Marked({gfm: true, breaks: false});
  m.use({tokenizer: {lheading() { return undefined; }}});
  MDR_MD = m;
  return m;
}
function mdrLexInline(src) {
  const lib = typeof marked !== 'undefined' ? marked : null;
  try { return lib ? lib.Lexer.lexInline(String(src), {gfm: true}) : null; } catch (e) { return null; }
}

/* ---------------- inline ---------------- */

/** Text as escaped html; `[^id]` becomes its footnote's number once the reply defines it. */
function mdrText(s, ctx) {
  const h = mdrEsc(s);
  if (!ctx.notes.list.length) return h;
  return h.replace(MDR_FN_REF, (m, id) => {
    const n = ctx.notes.index.get(id.toLowerCase());
    return n ? '<sup class="mdfn">' + n + '</sup>' : m;
  });
}

function mdrInlineTokens(tokens, ctx) {
  let out = '';
  for (const t of tokens || []) out += mdrInlineToken(t, ctx);
  return out;
}
/** A piece of markdown source drawn as inline marks (a field's key or value, a callout's line). */
function mdrInlineSrc(src, ctx) {
  const toks = mdrLexInline(src);
  return toks ? mdrInlineTokens(toks, ctx) : mdrEsc(src);
}

function mdrInlineToken(t, ctx) {
  switch (t.type) {
    case 'text': return t.tokens && t.tokens.length ? mdrInlineTokens(t.tokens, ctx) : mdrText(t.text, ctx);
    case 'escape': return mdrEsc(t.text);
    case 'strong': return '<strong>' + mdrInlineTokens(t.tokens, ctx) + '</strong>';
    case 'em': return '<em>' + mdrInlineTokens(t.tokens, ctx) + '</em>';
    case 'del': return '<s>' + mdrInlineTokens(t.tokens, ctx) + '</s>';
    case 'codespan': return mdrHold(ctx.held, '<code class="mdcode">' + mdrEsc(t.text) + '</code>');
    case 'br': return '\n';
    case 'link': case 'image': return mdrLinkToken(t, ctx);
    case 'checkbox': return '';
    // Raw HTML (and anything unknown) is shown as the model wrote it.
    default: return mdrEsc(t.raw || '');
  }
}

/** The host a card names, from an escaped http(s) URL. */
function mdrHost(href) {
  const m = /^https?:\/\/([^\/?#:]+)/i.exec(href.replace(/&amp;/g, '&'));
  return m ? m[1].replace(/^www\./i, '') : '';
}
/** A raw link target as an escaped href, or '' — only http(s) leaves the window (main's app:openExternal says the same). */
function mdrSafeHref(target) {
  const s = String(target || '').trim();
  if (/^www\./i.test(s)) return /[\s"<>]/.test(s) ? '' : mdrEsc('https://' + s);
  return /^https?:\/\/[^\s"<>]+$/i.test(s) ? mdrEsc(s) : '';
}
function mdrLink(href, inner, card) {
  if (!card) return '<a class="msglink" href="#" data-url="' + href + '">' + inner + '</a>';
  const host = mdrHost(href);
  return '<a class="msglink mdcard" href="#" data-url="' + href + '"><span class="mdcard-ic" aria-hidden="true">↗</span>'
    + '<span class="mdcard-tx"><span class="mdcard-t">' + inner + '</span>'
    + (host ? '<span class="mdcard-h">' + host + '</span>' : '') + '</span></a>';
}
/** Placeholders do not nest: held code inside a link's text is put back into it now. */
function mdrUnhold(html, ctx) { return html.replace(/\u0000(\d+)\u0000/g, (x, i) => ctx.held[+i] || ''); }

function mdrLinkToken(t, ctx, card) {
  const raw = t.raw || '';
  const fn = /^\[\^([^\]\s]{1,40})\]$/.exec(raw);
  if (fn) return mdrText(raw, ctx);   // `[^1]` that marked took for a reference link: a footnote mark
  // GFM autolinks (a bare URL, www., an e-mail) stay text: renderProseFresh's URL pass links them, as it always has.
  if (raw[0] === '<') return mdrEsc(t.text || '');
  if (raw[0] !== '[' && raw[0] !== '!') return mdrText(raw, ctx);
  const href = mdrSafeHref(t.href);
  const inner = t.type === 'image' ? mdrEsc(t.text) : mdrUnhold(mdrInlineTokens(t.tokens, ctx), ctx);
  if (href) {
    const at = ctx.held.length;
    ctx.held.push(mdrLink(href, inner, !!card));
    return '\u0000' + at + '\u0000';
  }
  /* A local target is left as text, so renderProse's own pass decides
     whether it is a file to offer a chip for (main checks it). Anything else
     (javascript:, data:, mailto:, a relative name, `handlers[name](event)`
     in prose) is shown exactly as written: no link, nothing lost. */
  const local = String(t.href || '').replace(/^file:\/\//i, '');
  if (/^(?:~\/|\/|[A-Za-z]:[\\/])/.test(local)) {
    const text = mdrEsc(t.text), loc = mdrEsc(local);
    return text === loc ? loc : text + ' (' + loc + ')';
  }
  return mdrText(raw, ctx);
}

/* ---------------- tables ---------------- */

const MDR_NUM = /^[-+−~≈]?\s?[$€£₽¥]?\s?\d[\d\s.,]*\s?(?:%|[kKmMbB]|[$€£₽¥])?$/;
const MDR_YES = /^(?:✅|✔️?|☑️|yes|да|\+)$/i;
const MDR_NO = /^(?:❌|✖️?|✗|no|нет)$/i;
/** ATO-163 tables (GitHub's rules, marked's parse), with ATO-1251's frame: Copy as TSV or markdown, numbers right-aligned. */
function mdrTableHtml(t, ctx) {
  const aligns = (t.align || []).map((a) => a || '');
  const head = t.header || [];
  const body = t.rows || [];
  const plain = (c) => String((c && c.text) || '').trim();
  // A column of numbers with no alignment of its own reads right-aligned, as in a spreadsheet.
  const numeric = head.map((_, i) => !aligns[i] && body.length > 0
    && body.every((r) => !plain(r[i]) || MDR_NUM.test(plain(r[i]))) && body.some((r) => plain(r[i])));
  const cell = (tag, c, i) => {
    const p = plain(c);
    const cls = tag === 'td' && MDR_YES.test(p) ? 'mdyes' : tag === 'td' && MDR_NO.test(p) ? 'mdno' : numeric[i] ? 'mdnum' : '';
    // The separator's own alignment is the style (t53 reads it); a numeric column's is the class's.
    return '<' + tag + (cls ? ' class="' + cls + '"' : '') + (aligns[i] ? ' style="text-align:' + aligns[i] + '"' : '')
      + '>' + (c ? mdrInlineTokens(c.tokens, ctx).replace(/\n/g, ' ') : '') + '</' + tag + '>';
  };
  const rows = body.map((r) => '<tr>' + head.map((_, i) => cell('td', r[i], i)).join('') + '</tr>');
  const n = body.length;
  return '<div class="mdtblx"><div class="mdbar"><span class="mdlang">' + n + (n === 1 ? ' row' : ' rows') + '</span>'
    + '<span class="mdtools">'
    + '<button class="mdcopy" data-mdtcopy="tsv" title="Copy for a spreadsheet (TSV)" aria-label="Copy table as TSV">' + mdrIcon() + '<span>Copy</span></button>'
    + '<button class="mdcopy" data-mdtcopy="md" title="Copy as markdown" aria-label="Copy table as markdown"><span>Markdown</span></button>'
    + '</span></div>'
    + '<div class="mdtbl"><table><thead><tr>' + head.map((c, i) => cell('th', c, i)).join('') + '</tr></thead>'
    + (rows.length ? '<tbody>' + rows.join('') + '</tbody>' : '') + '</table></div></div>';
}
function mdrIcon() { return typeof ic === 'function' ? ic('copy') : ''; }

/**
 * A table's cells as text for the clipboard. `rows` is the header row first,
 * `aligns` the header's own alignments ('' | left | center | right).
 */
function mdTableText(rows, aligns, kind) {
  const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (kind === 'tsv') return rows.map((r) => r.map((c) => clean(c).replace(/\t/g, ' ')).join('\t')).join('\n');
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  const line = (r) => '| ' + Array.from({length: width}, (_, i) => clean(r[i]).replace(/\|/g, '\\|')).join(' | ') + ' |';
  const sep = '| ' + Array.from({length: width}, (_, i) => {
    const a = (aligns || [])[i] || '';
    return a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---';
  }).join(' | ') + ' |';
  return [line(rows[0] || []), sep, ...rows.slice(1).map(line)].join('\n');
}

/* ---------------- lists ---------------- */

const MDR_KV = /^\*\*([^*\n]{1,60}?)\s*(?::\*\*|\*\*\s*[:：])\s*(.+)$/;
const MDR_KV_DASH = /^\*\*([^*\n]{1,60}?)\*\*\s+[—–]\s+(.+)$/;
function mdrKv(text) {
  const m = MDR_KV.exec(text) || MDR_KV_DASH.exec(text);
  if (!m || MDR_CALLOUT[m[1].trim().toLowerCase()]) return null;
  return {k: m[1].trim(), v: m[2]};
}
function mdrKvHtml(pairs, ctx) {
  return '<dl class="mdkv">' + pairs.map((p) => '<div class="mdkv-r"><dt>' + mdrInlineSrc(p.k, ctx) + '</dt><dd>' + mdrInlineSrc(p.v, ctx) + '</dd></div>').join('') + '</dl>';
}

const mdrIsList = (c) => c.type === 'list';

/** An item: its own text (tight `text` or loose `paragraph`s), then what nests under it. */
function mdrItemHtml(item, ctx, depth) {
  const own = [];
  let rest = '';
  let nested = false;
  for (const c of item.tokens || []) {
    if (c.type === 'checkbox' || c.type === 'space') continue;
    if (mdrIsList(c)) { nested = true; rest += mdrListHtml(c, ctx, depth + 1); continue; }
    const piece = (c.type === 'text' || c.type === 'paragraph')
      ? (c.tokens ? mdrInlineTokens(c.tokens, ctx) : mdrText(c.text, ctx)).replace(/\n+$/, '')
      : depth < MDR_MAX_DEPTH ? mdrBlock(c, ctx, depth + 1) : mdrEsc(String(c.raw || '').replace(/\n+$/, ''));
    if (nested) rest += (rest ? '\n' : '') + piece; else own.push(piece);
  }
  const body = own.join('\n');
  if (!item.task) return '<li>' + body + rest + '</li>';
  return '<li class="mdtask' + (item.checked ? ' done' : '') + '"><span class="mdchk" aria-hidden="true">' + (item.checked ? '✓' : '') + '</span>'
    + '<span class="mdtask-t">' + body + '</span>' + rest + '</li>';
}

function mdrListHtml(list, ctx, depth) {
  const items = list.items || [];
  if (!items.length) return '';
  const ordered = !!list.ordered;
  const text = (it) => String(it.text || '').trim();
  const flat = items.every((it) => !(it.tokens || []).some(mdrIsList) && text(it).indexOf('\n') < 0);
  // `- **Key:** value` on every line is a set of fields, not a list.
  if (!ordered && flat && items.length >= 2 && !items.some((it) => it.task)) {
    const pairs = items.map((it) => mdrKv(text(it)));
    if (pairs.every(Boolean)) return mdrKvHtml(pairs, ctx);
  }
  const tasks = items.some((it) => it.task);
  // Numbered items that each lead with a bold name are steps: drawn as a numbered track.
  const steps = ordered && depth === 0 && items.length >= 2 && items.every((it) => /^\*\*[^*\n]+\*\*/.test(text(it)));
  const first = ordered ? parseInt(list.start, 10) : 1;
  const tag = ordered ? 'ol' : 'ul';
  const start = ordered && first > 1 ? ' start="' + first + '"' : '';
  const cls = 'mdlist' + (steps ? ' mdsteps' : '') + (tasks ? ' mdtasks' : '');
  const reset = steps && first > 1 ? ' style="counter-reset:mdstep ' + (first - 1) + '"' : '';
  return '<' + tag + ' class="' + cls + '"' + start + reset + '>' + items.map((it) => mdrItemHtml(it, ctx, depth)).join('') + '</' + tag + '>';
}

/* ---------------- callouts and quotes ---------------- */

function mdrCalloutHtml(kind, title, bodyHtml) {
  return '<div class="mdcallout mdc-' + kind + '" role="note"><div class="mdcallout-t">' + (title || MDR_CALLOUT_TITLE[kind]) + '</div>'
    + (bodyHtml ? '<div class="mdcallout-b">' + bodyHtml + '</div>' : '') + '</div>';
}

/** `**Note:** text`, `⚠️ text`, `Важно: text` — the kind, its (escaped) title and the rest of the line; or null. */
function mdrCalloutLead(line) {
  let rest = line, kind = null;
  const em = /^(⚠️|⚠|❗️|❗|ℹ️|ℹ|💡|🚨|⛔️|⛔)\s*(.*)$/u.exec(line);
  if (em) { kind = MDR_EMOJI_CALLOUT[em[1]]; rest = em[2]; }
  const m = /^\*\*([^*:\n]{2,20}?)\s*:\*\*\s*(.*)$/.exec(rest)        // **Note:** text
    || /^\*\*([^*:\n]{2,20}?)\*\*\s*:\s*(.*)$/.exec(rest)               // **Note**: text
    || /^([A-Za-zА-Яа-яЁё ]{2,20}?):\s+(\S.*)$/.exec(rest);              // Note: text
  const named = m && MDR_CALLOUT[m[1].trim().toLowerCase()];
  if (named) {
    const title = m[1].trim();
    return {kind: named, title: mdrEsc(title.charAt(0).toUpperCase() + title.slice(1)), rest: m[2]};
  }
  return kind && rest.trim() ? {kind, title: '', rest} : null;
}

/** Markdown source (a quote's inside) drawn as blocks, or as one escaped line past the depth cap. */
function mdrBlocksSrc(src, ctx, depth) {
  if (depth > MDR_MAX_DEPTH) return mdrEsc(src.replace(/\n/g, ' '));
  const md = mdrMarked();
  let toks = null;
  try { toks = md ? md.lexer(src) : null; } catch (e) { toks = null; }
  return toks ? mdrBlocks(toks, ctx, depth) : mdrEsc(src);
}

function mdrQuoteHtml(t, ctx, depth) {
  const lines = String(t.text || '').replace(/\n+$/, '').split('\n');
  // GitHub's callouts: > [!NOTE]
  const gh = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(.*)$/i.exec(lines[0]);
  if (gh) {
    const rest = (gh[2] ? [gh[2]] : []).concat(lines.slice(1)).join('\n');
    return mdrCalloutHtml(gh[1].toLowerCase(), '', rest.trim() ? mdrBlocksSrc(rest, ctx, depth + 1) : '');
  }
  const lead = mdrCalloutLead(lines[0]);
  if (lead) {
    const rest = (lead.rest ? [lead.rest] : []).concat(lines.slice(1)).join('\n');
    return mdrCalloutHtml(lead.kind, lead.title, rest.trim() ? mdrBlocksSrc(rest, ctx, depth + 1) : '');
  }
  const inner = depth < MDR_MAX_DEPTH ? mdrBlocks(t.tokens || [], ctx, depth + 1) : mdrEsc(lines.join(' '));
  return '<blockquote class="mdquote">' + inner + '</blockquote>';
}

/* ---------------- code ---------------- */

/* An open fence (a streaming reply's last block, its closing ``` not here
   yet) is drawn as the code block it will be, marked data-open, so the reply
   neither shows backticks nor jumps into a frame when the fence closes. */
function mdrCodeHtml(t) {
  const raw = String(t.raw || '').replace(/\n+$/, '');
  const fenced = t.codeBlockStyle !== 'indented';
  const lines = raw.split('\n');
  const open = fenced && !(lines.length > 1 && /^ {0,3}(?:`{3,}|~{3,})[ \t]*$/.test(lines[lines.length - 1]));
  // ATO-430: the fence's info string (```js) is the language, not code: it moves to a small label.
  const lang = fenced ? (/^[\w+#.-]+/.exec(String(t.lang || '').trim()) || [''])[0] : '';
  const code = String(t.text || '').replace(/\n+$/, '');
  return '<pre class="mdpre"' + (open ? ' data-open="1"' : '') + (lang ? ' data-lang="' + mdrEsc(lang) + '"' : '') + '><code>'
    + mdrEsc(code) + (code ? '\n' : '') + '</code></pre>';
}

/* ---------------- paragraphs ---------------- */

function mdrParagraph(t, ctx, depth) {
  const raw = String(t.raw || '').replace(/\n+$/, '');
  const lines = raw.split('\n');
  const toks = (t.tokens || []).filter((x) => !(x.type === 'text' && !String(x.raw || '').trim()));

  // Two or more lines of `**Key:** value` read as fields; the lines around them stay prose.
  const kv = lines.map((l) => mdrKv(l.trim()));
  if (kv.some((p, i) => p && kv[i + 1])) {
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      let end = i;
      while (kv[i] && end + 1 < lines.length && kv[end + 1]) end++;
      if (end > i) { out.push(mdrKvHtml(kv.slice(i, end + 1), ctx)); i = end; continue; }
      out.push(mdrInlineSrc(lines[i], ctx));
    }
    return out.join('\n');
  }

  // `**Note:** …` / `⚠️ …` opening a paragraph: a callout, to the paragraph's end.
  const lead = mdrCalloutLead(lines[0]);
  if (lead) {
    const rest = [lead.rest].concat(lines.slice(1)).filter((l) => l.trim());
    return mdrCalloutHtml(lead.kind, lead.title, rest.map((l) => mdrInlineSrc(l, ctx)).join('\n'));
  }

  if (lines.length === 1) {
    const solo = raw.trim();
    // A link alone on its line is a card.
    if (toks.length === 1 && toks[0].type === 'link' && /^\[/.test(toks[0].raw || '') && mdrSafeHref(toks[0].href)) {
      return mdrLinkToken(toks[0], ctx, true);
    }
    // So is a bare URL.
    if (MDR_URL_LINE.test(solo)) {
      const trail = (solo.match(/[.,;:!?)\]}>"'»]+$/) || [''])[0];
      const core = solo.slice(0, solo.length - trail.length);
      const href = mdrSafeHref(core);
      if (href) {
        const shown = core.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
        return mdrHold(ctx.held, mdrLink(href, mdrEsc(shown.length > 80 ? shown.slice(0, 77) + '…' : shown), true)) + mdrEsc(trail);
      }
    }
    // A path alone on its line (bare or in a code span) is wrapped for the file card.
    const onlyCode = toks.length === 1 && toks[0].type === 'codespan' ? String(toks[0].text || '').trim() : null;
    if (MDR_PATH_LINE.test(solo) || (onlyCode && MDR_PATH_LINE.test(onlyCode))) {
      return '<span class="mdsolo">' + mdrInlineTokens(t.tokens, ctx) + '</span>';
    }
  }
  return mdrInlineTokens(t.tokens, ctx).replace(/\n+$/, '');
}

/* ---------------- footnotes ---------------- */

/** `[^id]: text` definitions anywhere at the top level: numbered in order, drawn at the end. */
function mdrFootnotes(tokens) {
  const notes = {list: [], index: new Map(), skip: new Set()};
  for (const t of tokens) {
    let lines = null;
    if (t.type === 'def' && /^\s*\[\^/.test(t.raw || '')) lines = String(t.raw).replace(/\n+$/, '').split('\n');
    else if (t.type === 'paragraph' && MDR_FN_DEF.test(String(t.raw || '').split('\n')[0])) lines = String(t.raw).replace(/\n+$/, '').split('\n');
    if (!lines) continue;
    notes.skip.add(t);
    let cur = null;
    for (const l of lines) {
      const m = MDR_FN_DEF.exec(l.trim());
      if (m) {
        const id = m[1].toLowerCase();
        if (notes.index.has(id)) { cur = null; continue; }
        cur = {id, text: m[2]};
        notes.index.set(id, notes.list.length + 1);
        notes.list.push(cur);
      } else if (cur && l.trim()) cur.text += '\n' + l.trim();
    }
  }
  return notes;
}
function mdrFootnotesHtml(ctx) {
  return '<ol class="mdlist mdfoot">' + ctx.notes.list.map((n) => '<li>' + mdrInlineSrc(n.text, ctx) + '</li>').join('') + '</ol>';
}

/* ---------------- blocks ---------------- */

function mdrBlock(t, ctx, depth) {
  switch (t.type) {
    case 'heading': {
      const n = Math.min(t.depth || 1, 4);
      return '<h' + n + ' class="mdh">' + mdrInlineTokens(t.tokens, ctx) + '</h' + n + '>';
    }
    case 'hr': return '<hr class="mdhr">';
    case 'code': return mdrHold(ctx.held, mdrCodeHtml(t));
    case 'table': return mdrTableHtml(t, ctx);
    case 'blockquote': return mdrQuoteHtml(t, ctx, depth);
    case 'list': return mdrListHtml(t, ctx, 0);
    case 'paragraph': return mdrParagraph(t, ctx, depth);
    case 'text': return (t.tokens ? mdrInlineTokens(t.tokens, ctx) : mdrText(t.text, ctx)).replace(/\n+$/, '');
    // Raw HTML blocks, and anything marked adds later, are shown as written.
    default: return mdrEsc(String(t.raw || '').replace(/\n+$/, ''));
  }
}

/** A "Pros" list and a "Cons" list (either order, a blank line apart at most) as two columns. */
function mdrCompareAt(tokens, at, ctx, depth) {
  const label = (t) => {
    if (!t || (t.type !== 'paragraph' && t.type !== 'heading')) return null;
    const s = String(t.raw || '').trim();
    return MDR_PROS.test(s) ? 'pro' : MDR_CONS.test(s) ? 'con' : null;
  };
  const part = (i) => {
    const kind = label(tokens[i]);
    if (!kind) return null;
    let j = i + 1;
    if (tokens[j] && tokens[j].type === 'space') j++;
    if (!tokens[j] || tokens[j].type !== 'list') return null;
    const title = String(tokens[i].raw).trim().replace(/^#{1,6}\s+/, '').replace(/\*\*/g, '').replace(/:\s*$/, '').replace(/^[✅❌]\s*/u, '').trim();
    return {pro: kind === 'pro', title, list: tokens[j], end: j};
  };
  const a = part(at);
  if (!a) return null;
  let k = a.end + 1;
  if (tokens[k] && tokens[k].type === 'space' && mdrNl(tokens[k].raw) <= 3) k++;
  const b = part(k);
  if (!b || b.pro === a.pro) return null;
  const col = (p) => '<div class="mdcmp-c ' + (p.pro ? 'pro' : 'con') + '"><div class="mdcmp-t">' + mdrEsc(p.title) + '</div>'
    + '<ul class="mdlist">' + p.list.items.map((it) => mdrItemHtml(it, ctx, depth + 1)).join('') + '</ul></div>';
  return {html: '<div class="mdcmp">' + col(a) + col(b) + '</div>', end: b.end};
}

/** Tokens drawn as blocks, one line of markup each; the model's blank lines between them are kept. */
function mdrBlocks(tokens, ctx, depth) {
  const out = [];
  let nl = -1;   // newlines since the last block drawn; -1 before the first
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'space') { if (nl >= 0) nl += mdrNl(t.raw); continue; }
    if (t.type === 'def' || ctx.notes.skip.has(t)) continue;
    let html, last = t;
    const cmp = mdrCompareAt(tokens, i, ctx, depth);
    if (cmp) { html = cmp.html; last = tokens[cmp.end]; i = cmp.end; }
    else html = mdrBlock(t, ctx, depth);
    for (let k = 1; k < nl; k++) out.push('');
    out.push(html);
    nl = mdrTrailNl(last.raw);
  }
  return out.join('\n');
}

/** renderMarkdown's body: the model's raw text in, {html, held} out (see the header). */
function mdRender(text) {
  const held = [];
  // A CRLF reply reads as LF.
  const src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  const md = mdrMarked();
  try {
    if (!md) throw new Error('marked is not loaded');
    const tokens = md.lexer(src);
    const ctx = {held, notes: mdrFootnotes(tokens)};
    let html = mdrBlocks(tokens, ctx, 0);
    if (ctx.notes.list.length) html += (html ? '\n' : '') + mdrFootnotesHtml(ctx);
    return {html, held};
  } catch (e) {
    // Never a blank reply: whatever went wrong, the text is still shown, escaped.
    return {html: mdrEsc(src), held: []};
  }
}

/* The finished reply's markup through DOMPurify (vendored), a second wall
   behind the escaping above. Our own markup passes untouched (classes, data-*,
   aria-*, buttons, inline svg icons); anything else would not. Where
   DOMPurify is not loaded (the Node checks) the markup is returned as is. */
function mdSanitize(html) {
  const P = typeof DOMPurify !== 'undefined' ? DOMPurify : null;
  if (!P || !P.isSupported || typeof P.sanitize !== 'function') return html;
  return P.sanitize(html, {FORBID_TAGS: ['style', 'form', 'input', 'textarea', 'select'], FORBID_ATTR: ['srcset']});
}

if (typeof module !== 'undefined') module.exports = {mdRender, mdTableText, mdSanitize};
