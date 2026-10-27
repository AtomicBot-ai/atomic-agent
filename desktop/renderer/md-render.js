/* ---------------- ATO-1251 / ATO-664: a reply's markdown, as blocks ----------------
   Loaded before renderer.js; declares only. Shared by the renderer
   (renderMarkdown hands its text here) and the Node checks
   (test/md-render.test.mjs).

   The model writes ordinary markdown; this turns it into the window's own
   blocks. Nothing new is asked of the model: a checklist is `- [ ]`, a
   callout is GitHub's `> [!NOTE]` or a `**Note:**` lead, key/value pairs are
   lines of `**Key:** value`, a comparison is a "Pros" list next to a "Cons"
   list, a card is a link or URL alone on its line.

   The contract is renderMarkdown's, unchanged:
   - input is ALREADY HTML-escaped, and only tags of this file's own are
     inserted, so nothing the model writes can become markup;
   - code (fences and spans) is held out as \u0000N\u0000 placeholders and NOT
     put back here: renderProseFresh runs its link and file-chip passes first
     and restores them last. Links made here are held the same way, so those
     passes never rewrite a URL inside an attribute;
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
const MDR_TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const MDR_ITEM = /^( *)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const MDR_URL_LINE = /^(?:https?:\/\/|www\.)[^\s<>"']+$/;
const MDR_PATH_LINE = /^(?:~\/|\/|[A-Za-z]:[\\/])[^\s]*[^\s\/\\]\.[A-Za-z0-9]{1,10}$/;

function mdrHold(held, html) { return '\u0000' + (held.push(html) - 1) + '\u0000'; }

/** Inline marks over escaped text. Held code and links are opaque placeholders here. */
function mdrInline(t) {
  return t
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])__([^_\n]+)__(?=$|[\s.,;:!?)])/g, '$1<strong>$2</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s.,;:!?)])/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s.,;:!?)])/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>');
}

/** The host a card names, from an escaped http(s) URL. */
function mdrHost(href) {
  const m = /^https?:\/\/([^\/?#:]+)/i.exec(href.replace(/&amp;/g, '&'));
  return m ? m[1].replace(/^www\./i, '') : '';
}
/** Only http(s) leaves the window (main's app:openExternal says the same). */
function mdrSafeHref(href) {
  const raw = href.replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim();
  if (/^www\./i.test(raw)) return 'https://' + href.trim();
  return /^https?:\/\/[^\s"<>]+$/i.test(raw) ? href.trim() : '';
}
function mdrLink(href, inner, card) {
  if (!card) return '<a class="msglink" href="#" data-url="' + href + '">' + inner + '</a>';
  const host = mdrHost(href);
  return '<a class="msglink mdcard" href="#" data-url="' + href + '"><span class="mdcard-ic" aria-hidden="true">↗</span>'
    + '<span class="mdcard-tx"><span class="mdcard-t">' + inner + '</span>'
    + (host ? '<span class="mdcard-h">' + host + '</span>' : '') + '</span></a>';
}

/**
 * Lifts code and links out of escaped text. Returns the text with
 * placeholders, the held markup, and which held entries are links (a line
 * that is only a link becomes a card).
 */
function mdrHoldInline(escaped, held) {
  const links = new Map();   // held index → {href, text}
  let t = escaped
    // ATO-430: the fence's info string (```js) is the language, not code: it moves to a small label.
    .replace(/```(?:([\w+#.-]+)[ \t]*(?=\r?\n))?([\s\S]*?)```/g, (m, lang, code) =>
      mdrHold(held, '<pre class="mdpre"' + (lang ? ' data-lang="' + lang + '"' : '') + '><code>' + code.replace(/^\r?\n/, '') + '</code></pre>'));
  /* While a reply streams, its last fence is open until the closing ``` lands.
     It is drawn as the code block it will be, so the reply does not show
     backticks and then jump into a frame when the fence closes. */
  t = t.replace(/(^|\n)```([\w+#.-]+)?[ \t]*\r?\n([\s\S]*)$/, (m, lead, lang, code) =>
    lead + mdrHold(held, '<pre class="mdpre" data-open="1"' + (lang ? ' data-lang="' + lang + '"' : '') + '><code>' + code + '</code></pre>'));
  t = t.replace(/`([^`\n]+)`/g, (m, code) => mdrHold(held, '<code class="mdcode">' + code + '</code>'));
  // [text](target) — the title part ("…") is dropped, as a chat shows no tooltips for it.
  t = t.replace(/(!?)\[([^\]\n]{1,500})\]\(\s*([^()\s]{1,2048})(?:\s+&quot;[^\n]*?&quot;)?\s*\)/g, (m, bang, text, target) => {
    const href = mdrSafeHref(target);
    // A held code span inside the text is put back now: placeholders do not nest.
    const inner = mdrInline(text).replace(/\u0000(\d+)\u0000/g, (x, i) => held[+i] || '');
    if (href) {
      const at = held.length;
      held.push(mdrLink(href, inner));
      links.set(at, {href, inner});
      return '\u0000' + at + '\u0000';
    }
    /* A local target is left as text, so renderProse's own pass decides
       whether it is a file to offer a chip for (main checks it). Anything
       else (javascript:, data:, a relative name) keeps only its words. */
    const local = target.replace(/^file:\/\//i, '');
    if (/^(?:~\/|\/|[A-Za-z]:[\\/])/.test(local)) return text === local ? local : text + ' (' + local + ')';
    return text;
  });
  return {t, links};
}

/* ---------------- tables ---------------- */

function mdrCells(line) {
  const body = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return body.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}
const MDR_NUM = /^[-+−~≈]?\s?[$€£₽¥]?\s?\d[\d\s.,]*\s?(?:%|[kKmMbB]|[$€£₽¥])?$/;
const MDR_YES = /^(?:✅|✔️?|☑️|yes|да|\+)$/i;
const MDR_NO = /^(?:❌|✖️?|✗|no|нет)$/i;
/** ATO-163 tables (GitHub's rules), with ATO-1251's frame: Copy as TSV or markdown, numbers right-aligned. */
function mdrTableAt(lines, at) {
  const head = (lines[at] || '').trim();
  const sep = lines[at + 1];
  if (!head.includes('|') || sep === undefined || !MDR_TABLE_SEP.test(sep) || !sep.includes('|') && !head.startsWith('|')) return null;
  const cols = mdrCells(head);
  const seps = mdrCells(sep);
  // As GitHub: the separator has as many cells as the header, or this is prose and a rule, not a table.
  if (seps.length !== cols.length || (cols.length < 2 && !head.startsWith('|'))) return null;
  const aligns = seps.map((c) => /^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : /^:-/.test(c) ? 'left' : '');
  let end = at + 1;
  const body = [];
  while (end + 1 < lines.length && lines[end + 1].trim() && lines[end + 1].includes('|')) {
    end++;
    body.push(mdrCells(lines[end]));
  }
  // A column of numbers with no alignment of its own reads right-aligned, as in a spreadsheet.
  const plain = (s) => (s || '').replace(/<[^>]+>/g, '').replace(/\u0000\d+\u0000/g, 'x').trim();
  const numeric = cols.map((_, i) => !aligns[i] && body.length > 0
    && body.every((r) => !plain(r[i]) || MDR_NUM.test(plain(r[i]))) && body.some((r) => plain(r[i])));
  const cell = (tag, text, i) => {
    const p = plain(text);
    const cls = tag === 'td' && MDR_YES.test(p) ? 'mdyes' : tag === 'td' && MDR_NO.test(p) ? 'mdno' : numeric[i] ? 'mdnum' : '';
    // The separator's own alignment is the style (t53 reads it); a numeric column's is the class's.
    return '<' + tag + (cls ? ' class="' + cls + '"' : '') + (aligns[i] ? ' style="text-align:' + aligns[i] + '"' : '')
      + '>' + mdrInline(text || '') + '</' + tag + '>';
  };
  const rows = body.map((c) => '<tr>' + cols.map((_, i) => cell('td', c[i], i)).join('') + '</tr>');
  const n = body.length;
  const html = '<div class="mdtblx"><div class="mdbar"><span class="mdlang">' + n + (n === 1 ? ' row' : ' rows') + '</span>'
    + '<span class="mdtools">'
    + '<button class="mdcopy" data-mdtcopy="tsv" title="Copy for a spreadsheet (TSV)" aria-label="Copy table as TSV">' + mdrIcon() + '<span>Copy</span></button>'
    + '<button class="mdcopy" data-mdtcopy="md" title="Copy as markdown" aria-label="Copy table as markdown"><span>Markdown</span></button>'
    + '</span></div>'
    + '<div class="mdtbl"><table><thead><tr>' + cols.map((c, i) => cell('th', c, i)).join('') + '</tr></thead>'
    + (rows.length ? '<tbody>' + rows.join('') + '</tbody>' : '') + '</table></div></div>';
  return {html, end};
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

function mdrIndent(s) { return s.replace(/\t/g, '    ').length; }

/** The lines from `at` that make up one list, and where it ends (inclusive). */
function mdrListEnd(lines, at) {
  const first = MDR_ITEM.exec(lines[at]);
  const ordered = /\d/.test(first[2]);
  const base = mdrIndent(first[1]);
  let end = at;
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i];
    const item = MDR_ITEM.exec(l);
    if (item && mdrIndent(item[1]) <= base + 1) {
      if (/\d/.test(item[2]) !== ordered) break;   // a bullet list after a numbered one is a new list
      end = i; continue;
    }
    if (item || (l.trim() && /^\s{2,}/.test(l))) { end = i; continue; }   // nested, or a continuation line
    // One blank line between two items of the same list keeps it one list (and its numbering).
    if (!l.trim() && i + 1 < lines.length) {
      const next = MDR_ITEM.exec(lines[i + 1]);
      if (next && mdrIndent(next[1]) <= base + 1 && /\d/.test(next[2]) === ordered) continue;
    }
    break;
  }
  return end;
}

/** Items of the list in lines[at..end], as a tree by indentation. */
function mdrListTree(lines, at, end) {
  const root = {children: [], indent: -1};
  const stack = [root];
  let last = null;
  for (let i = at; i <= end; i++) {
    const l = lines[i];
    const m = MDR_ITEM.exec(l);
    if (!m) {
      if (last && l.trim()) last.text += '\n' + l.trim();
      continue;
    }
    const indent = mdrIndent(m[1]);
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1];
    const node = {indent, ordered: /\d/.test(m[2]), n: parseInt(m[2], 10), text: m[3], children: []};
    parent.children.push(node);
    stack.push(node);
    last = node;
  }
  return root.children;
}

const MDR_KV = /^\*\*([^*\n]{1,60}?)\s*(?::\*\*|\*\*\s*[:：])\s*(.+)$/;
const MDR_KV_DASH = /^\*\*([^*\n]{1,60}?)\*\*\s+[—–]\s+(.+)$/;
function mdrKv(text) {
  const m = MDR_KV.exec(text) || MDR_KV_DASH.exec(text);
  if (!m || MDR_CALLOUT[m[1].trim().toLowerCase()]) return null;
  return {k: m[1].trim(), v: m[2]};
}
function mdrKvHtml(pairs) {
  return '<dl class="mdkv">' + pairs.map((p) => '<div class="mdkv-r"><dt>' + mdrInline(p.k) + '</dt><dd>' + mdrInline(p.v) + '</dd></div>').join('') + '</dl>';
}

function mdrItemHtml(node, depth) {
  let text = node.text;
  let task = null;
  const tm = /^\[([ xX])\]\s+([\s\S]*)$/.exec(text);
  if (tm) { task = tm[1] !== ' '; text = tm[2]; }
  const body = text.split('\n').map(mdrInline).join('\n');
  const kids = node.children.length ? mdrListHtml(node.children, depth + 1) : '';
  if (task === null) return '<li>' + body + kids + '</li>';
  return '<li class="mdtask' + (task ? ' done' : '') + '"><span class="mdchk" aria-hidden="true">' + (task ? '✓' : '') + '</span>'
    + '<span class="mdtask-t">' + body + '</span>' + kids + '</li>';
}

function mdrListHtml(items, depth) {
  const ordered = items[0].ordered;
  const flat = items.every((n) => !n.children.length && n.text.indexOf('\n') < 0);
  // `- **Key:** value` on every line is a set of fields, not a list.
  if (!ordered && flat && items.length >= 2) {
    const pairs = items.map((n) => mdrKv(n.text));
    if (pairs.every(Boolean)) return mdrKvHtml(pairs);
  }
  const tasks = items.some((n) => /^\[[ xX]\]\s/.test(n.text));
  // Numbered items that each lead with a bold name are steps: drawn as a numbered track.
  const steps = ordered && depth === 0 && items.length >= 2 && items.every((n) => /^\*\*[^*\n]+\*\*/.test(n.text));
  const tag = ordered ? 'ol' : 'ul';
  const start = ordered && items[0].n > 1 ? ' start="' + items[0].n + '"' : '';
  const cls = 'mdlist' + (steps ? ' mdsteps' : '') + (tasks ? ' mdtasks' : '');
  const reset = steps && items[0].n > 1 ? ' style="counter-reset:mdstep ' + (items[0].n - 1) + '"' : '';
  return '<' + tag + ' class="' + cls + '"' + start + reset + '>' + items.map((n) => mdrItemHtml(n, depth)).join('') + '</' + tag + '>';
}

/* ---------------- callouts and quotes ---------------- */

function mdrCalloutHtml(kind, title, bodyHtml) {
  return '<div class="mdcallout mdc-' + kind + '" role="note"><div class="mdcallout-t">' + (title || MDR_CALLOUT_TITLE[kind]) + '</div>'
    + (bodyHtml ? '<div class="mdcallout-b">' + bodyHtml + '</div>' : '') + '</div>';
}

/** `**Note:** text`, `⚠️ text`, `Важно: text` — the kind, its title and the rest of the line; or null. */
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
    return {kind: named, title: title.charAt(0).toUpperCase() + title.slice(1), rest: m[2]};
  }
  return kind && rest.trim() ? {kind, title: '', rest} : null;
}

/* ---------------- blocks ---------------- */

function mdrIsBlockStart(lines, i) {
  const l = lines[i];
  return /^#{1,6}\s/.test(l) || /^&gt;/.test(l) || MDR_ITEM.test(l) || !!mdrTableAt(lines, i) || /^\s*([-*_])\1{2,}\s*$/.test(l);
}

function mdrBlocks(lines, held, links, depth) {
  const out = [];
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at].replace(/\s+$/, '');
    /* ATO-163: a table — a row of cells, then a dashed separator row — is one
       line of markup (no newlines inside it for `pre-wrap` to keep), in a
       wrapper that scrolls sideways instead of pushing the reply wider. */
    const table = mdrTableAt(lines, at);
    if (table) { out.push(table.html); at = table.end; continue; }

    // Pros / Cons, side by side.
    if (MDR_PROS.test(line.trim()) || MDR_CONS.test(line.trim())) {
      const cmp = mdrCompareAt(lines, at, held, links, depth);
      if (cmp) { out.push(cmp.html); at = cmp.end; continue; }
    }

    const heading = /^(#{1,6})\s+(.*?)(?:\s+#+)?$/.exec(line);
    if (heading) {
      const n = Math.min(heading[1].length, 4);
      out.push('<h' + n + ' class="mdh">' + mdrInline(heading[2]) + '</h' + n + '>');
      continue;
    }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { out.push('<hr class="mdhr">'); continue; }

    // > quotes, and GitHub's callouts inside them (> [!NOTE]).
    if (/^&gt;/.test(line)) {
      let end = at;
      while (end + 1 < lines.length && /^&gt;/.test(lines[end + 1])) end++;
      const inner = lines.slice(at, end + 1).map((l) => l.replace(/^&gt;\s?/, ''));
      at = end;
      const gh = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(.*)$/i.exec(inner[0]);
      if (gh) {
        const kind = gh[1].toLowerCase();
        const rest = (gh[2] ? [gh[2]] : []).concat(inner.slice(1));
        out.push(mdrCalloutHtml(kind, '', depth < MDR_MAX_DEPTH ? mdrBlocks(rest, held, links, depth + 1) : mdrInline(rest.join(' '))));
        continue;
      }
      const lead = mdrCalloutLead(inner[0]);
      if (lead) {
        const rest = (lead.rest ? [lead.rest] : []).concat(inner.slice(1));
        out.push(mdrCalloutHtml(lead.kind, lead.title, depth < MDR_MAX_DEPTH ? mdrBlocks(rest, held, links, depth + 1) : mdrInline(rest.join(' '))));
        continue;
      }
      out.push('<blockquote class="mdquote">' + (depth < MDR_MAX_DEPTH ? mdrBlocks(inner, held, links, depth + 1) : mdrInline(inner.join(' '))) + '</blockquote>');
      continue;
    }

    if (MDR_ITEM.test(line)) {
      const end = mdrListEnd(lines, at);
      out.push(mdrListHtml(mdrListTree(lines, at, end), 0));
      at = end;
      continue;
    }

    // Two or more lines of `**Key:** value` read as fields.
    if (mdrKv(line)) {
      let end = at;
      while (end + 1 < lines.length && mdrKv(lines[end + 1].trim())) end++;
      if (end > at) {
        out.push(mdrKvHtml(lines.slice(at, end + 1).map((l) => mdrKv(l.trim()))));
        at = end;
        continue;
      }
    }

    // `**Note:** …` / `⚠️ …` opening a paragraph: a callout, to the paragraph's end.
    const lead = (at === 0 || !lines[at - 1].trim()) ? mdrCalloutLead(line) : null;
    if (lead) {
      let end = at;
      while (end + 1 < lines.length && lines[end + 1].trim() && !mdrIsBlockStart(lines, end + 1)) end++;
      const rest = [lead.rest].concat(lines.slice(at + 1, end + 1)).filter((l) => l.trim());
      out.push(mdrCalloutHtml(lead.kind, lead.title, rest.map(mdrInline).join('\n')));
      at = end;
      continue;
    }

    // A link or URL alone on its line is a card; a path alone on its line, a file card.
    const solo = line.trim();
    const onlyLink = /^\u0000(\d+)\u0000$/.exec(solo);
    if (onlyLink && links.has(+onlyLink[1])) {
      const l = links.get(+onlyLink[1]);
      held[+onlyLink[1]] = mdrLink(l.href, l.inner, true);
      out.push(solo);
      continue;
    }
    if (MDR_URL_LINE.test(solo)) {
      const trail = (solo.match(/[.,;:!?)\]}>"'»]+$/) || [''])[0];
      const core = solo.slice(0, solo.length - trail.length);
      const href = mdrSafeHref(core);
      if (href) {
        const shown = core.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
        out.push(mdrHold(held, mdrLink(href, shown.length > 80 ? shown.slice(0, 77) + '…' : shown, true)) + trail);
        continue;
      }
    }
    const heldCode = /^\u0000(\d+)\u0000$/.exec(solo);
    const codeText = heldCode ? (/^<code class="mdcode">([\s\S]*)<\/code>$/.exec(held[+heldCode[1]] || '') || [])[1] : null;
    if (MDR_PATH_LINE.test(solo) || (codeText && MDR_PATH_LINE.test(codeText.trim()))) {
      out.push('<span class="mdsolo">' + solo + '</span>');
      continue;
    }

    out.push(line ? mdrInline(line) : '');
  }
  return out.join('\n');
}

/** A "Pros" list and a "Cons" list (either order, a blank line apart at most) as two columns. */
function mdrCompareAt(lines, at, held, links, depth) {
  const part = (i) => {
    const label = lines[i].trim();
    const pro = MDR_PROS.test(label);
    if (!pro && !MDR_CONS.test(label)) return null;
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    if (j >= lines.length || !MDR_ITEM.test(lines[j])) return null;
    const end = mdrListEnd(lines, j);
    const title = label.replace(/^#{1,6}\s+/, '').replace(/\*\*/g, '').replace(/:\s*$/, '').replace(/^[✅❌]\s*/u, '').trim();
    return {pro, title, items: mdrListTree(lines, j, end), end};
  };
  const a = part(at);
  if (!a) return null;
  let k = a.end + 1;
  while (k < lines.length && !lines[k].trim() && k - a.end <= 2) k++;
  const b = k < lines.length ? part(k) : null;
  if (!b || b.pro === a.pro) return null;
  const col = (p) => '<div class="mdcmp-c ' + (p.pro ? 'pro' : 'con') + '"><div class="mdcmp-t">' + mdrInline(p.title) + '</div>'
    + '<ul class="mdlist">' + p.items.map((n) => mdrItemHtml(n, depth + 1)).join('') + '</ul></div>';
  return {html: '<div class="mdcmp">' + col(a) + col(b) + '</div>', end: b.end};
}

/** renderMarkdown's body: escaped text in, {html, held} out (see the header). */
function mdRender(escaped) {
  const held = [];
  const {t, links} = mdrHoldInline(escaped, held);
  return {html: mdrBlocks(t.split('\n'), held, links, 0), held};
}

if (typeof module !== 'undefined') module.exports = {mdRender, mdTableText, mdrInline};
