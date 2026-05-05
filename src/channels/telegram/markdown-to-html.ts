/**
 * Convert agent-emitted markdown into Telegram's HTML subset for use
 * with `parse_mode: "HTML"`. The converter is intentionally narrow:
 * it targets the markdown shapes LLMs actually emit (headings, bold,
 * italic, code, links, lists, blockquotes) and ignores everything
 * else by passing it through as escaped plain text. Telegram's HTML
 * dialect supports only a small whitelist of tags — see
 * https://core.telegram.org/bots/api#html-style — so any tag not in
 * that whitelist is omitted on purpose.
 *
 * Design choices:
 *
 *  - Line-based block detection (headings, blockquotes, lists) runs
 *    before inline parsing so the inline pass never sees the line
 *    prefix sigils. Lists are not natively supported by Telegram, so
 *    we render them with bullet glyphs and a leading newline.
 *  - Code spans and fenced blocks are extracted to placeholder tokens
 *    *first* so their bodies never get inline-parsed (a `*` inside a
 *    code block must remain a literal `*`). Placeholders carry the
 *    HTML-escaped body verbatim; the restore pass wraps them in
 *    `<code>` / `<pre>` and substitutes back.
 *  - All non-tag text passes through `escapeHtmlText` so stray `<`,
 *    `>`, `&` characters can never be misinterpreted as tags.
 *  - Links are validated: only `http://`, `https://`, `tg://`, and
 *    `mailto:` schemes are emitted as `<a>`; anything else falls
 *    through as escaped text so the converter cannot smuggle a
 *    `javascript:` URL into the operator's chat.
 */

const PLACEHOLDER_PREFIX = "\u0000ATOMIC_TG_PH_";
const PLACEHOLDER_SUFFIX = "\u0000";

interface Placeholder {
  kind: "inline_code" | "fenced_code";
  body: string;
  language?: string;
}

const SAFE_URL_SCHEME = /^(?:https?|tg|mailto):/i;

/**
 * Convert `markdown` into Telegram-compatible HTML. The output is
 * suitable for `sendMessage(..., { parse_mode: "HTML" })`. Pure — no
 * I/O, no allocation beyond the result string. Empty input returns
 * an empty string.
 */
export function convertMarkdownToTelegramHtml(markdown: string): string {
  if (markdown.length === 0) return "";
  const placeholders: Placeholder[] = [];
  const withFences = extractFencedCode(markdown, placeholders);
  const withCode = extractInlineCode(withFences, placeholders);
  const blocks = renderBlocks(withCode);
  const inline = renderInline(blocks);
  return restorePlaceholders(inline, placeholders);
}

/**
 * Escape `<`, `>`, `&` so they cannot be parsed as HTML entities or
 * tag delimiters by the Telegram client. Exported because the
 * outbound layer needs the same escape for fallback paths that send
 * plain text under `parse_mode: "HTML"`.
 */
export function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function extractFencedCode(text: string, store: Placeholder[]): string {
  // Matches ```lang\n...\n``` and ```...``` fenced blocks. The body
  // is captured verbatim (including newlines) and stashed as a
  // placeholder so the inline pass can never touch it.
  return text.replace(
    /```([^\n`]*)\n?([\s\S]*?)```/g,
    (_match, langRaw: string, bodyRaw: string) => {
      const language = langRaw.trim();
      const body = bodyRaw.replace(/\n$/, "");
      const id = store.length;
      store.push({
        kind: "fenced_code",
        body,
        ...(language ? { language } : {}),
      });
      return `${PLACEHOLDER_PREFIX}${id}${PLACEHOLDER_SUFFIX}`;
    },
  );
}

function extractInlineCode(text: string, store: Placeholder[]): string {
  // Matches single-backtick spans, refusing to match across newlines
  // (markdown rule). Double-backtick spans (``foo``) collapse to the
  // same handling — the inner backtick survives as literal.
  return text.replace(/`([^`\n]+)`/g, (_match, body: string) => {
    const id = store.length;
    store.push({ kind: "inline_code", body });
    return `${PLACEHOLDER_PREFIX}${id}${PLACEHOLDER_SUFFIX}`;
  });
}

function renderBlocks(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const heading = matchHeading(line);
    if (heading !== null) {
      out.push(`<b>${heading}</b>`);
      i += 1;
      continue;
    }
    if (isBlockquoteLine(line)) {
      const block: string[] = [];
      while (i < lines.length && isBlockquoteLine(lines[i]!)) {
        block.push(stripBlockquotePrefix(lines[i]!));
        i += 1;
      }
      out.push(`<blockquote>${block.join("\n")}</blockquote>`);
      continue;
    }
    const bullet = matchListItem(line);
    if (bullet !== null) {
      out.push(`• ${bullet}`);
      i += 1;
      continue;
    }
    out.push(line);
    i += 1;
  }
  return out.join("\n");
}

function matchHeading(line: string): string | null {
  const m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
  if (!m) return null;
  return m[2] ?? "";
}

function isBlockquoteLine(line: string): boolean {
  return /^\s{0,3}>\s?/.test(line);
}

function stripBlockquotePrefix(line: string): string {
  return line.replace(/^\s{0,3}>\s?/, "");
}

function matchListItem(line: string): string | null {
  // Unordered (`-`, `*`, `+`) or ordered (`1.`, `2)`). The body is
  // returned without the marker; nesting is flattened — Telegram's
  // HTML dialect has no `<ul>` / `<ol>` so visual hierarchy is lost.
  const unordered = /^\s{0,6}[-*+]\s+(.*)$/.exec(line);
  if (unordered) return unordered[1] ?? "";
  const ordered = /^\s{0,6}\d{1,9}[.)]\s+(.*)$/.exec(line);
  if (ordered) return ordered[1] ?? "";
  return null;
}

function renderInline(text: string): string {
  // Run inline transforms in an order that doesn't accidentally
  // consume the wrong delimiters: links first (so their `[text]` is
  // not eaten by emphasis), then emphasis pairs from longest to
  // shortest, then escape leftover plain text.
  const segments = splitOnPlaceholders(text);
  const transformed = segments.map((seg) => {
    if (seg.kind === "placeholder") return seg.text;
    let s = seg.text;
    s = renderLinks(s);
    s = renderStrikethrough(s);
    s = renderBold(s);
    s = renderItalic(s);
    return s;
  });
  return transformed.join("");
}

interface Segment {
  kind: "text" | "placeholder";
  text: string;
}

function splitOnPlaceholders(text: string): Segment[] {
  const out: Segment[] = [];
  const re = new RegExp(`${PLACEHOLDER_PREFIX}(\\d+)${PLACEHOLDER_SUFFIX}`, "g");
  let last = 0;
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    if (start > last) {
      out.push({ kind: "text", text: text.slice(last, start) });
    }
    out.push({ kind: "placeholder", text: m[0] });
    last = start + m[0].length;
  }
  if (last < text.length) {
    out.push({ kind: "text", text: text.slice(last) });
  }
  return out;
}

function renderLinks(s: string): string {
  // Markdown link `[text](url)` — the text portion is escaped in the
  // generic pass below, the URL portion is escaped here. Anchors
  // with unsafe schemes degrade to `text (url)` plain text so we
  // never emit `<a href="javascript:...">`.
  return s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label: string, url: string) => {
    if (!SAFE_URL_SCHEME.test(url)) {
      return `${escapeHtmlText(label)} (${escapeHtmlText(url)})`;
    }
    return `<a href="${escapeHtmlAttr(url)}">${applyEmphasis(label)}</a>`;
  });
}

function applyEmphasis(label: string): string {
  // Link labels themselves may contain bold / italic / code spans.
  // We re-run the emphasis pass over them; placeholders cannot
  // appear in a markdown link label by construction (code-fence
  // extraction runs before any label is seen).
  let s = renderStrikethrough(label);
  s = renderBold(s);
  s = renderItalic(s);
  return s.includes("&") || s.includes("<") || s.includes(">")
    ? s
    : escapeHtmlText(s);
}

function renderBold(s: string): string {
  return s
    .replace(/\*\*([^*\n]+?)\*\*/g, "<b>$1</b>")
    .replace(/__([^_\n]+?)__/g, "<b>$1</b>");
}

function renderItalic(s: string): string {
  // Single `*` or `_` only. We require a non-word boundary on the
  // outer side for `_` so `snake_case_identifier` does not turn
  // into `snake<i>case</i>identifier`. The same guard for `*` is
  // not needed because `*` is rare inside identifiers.
  return s
    .replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, "$1<i>$2</i>")
    .replace(/(^|[^_\w])_([^_\n]+?)_(?!\w)/g, "$1<i>$2</i>");
}

function renderStrikethrough(s: string): string {
  return s.replace(/~~([^~\n]+?)~~/g, "<s>$1</s>");
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function restorePlaceholders(text: string, store: Placeholder[]): string {
  // Two passes: first walk segments and HTML-escape the non-placeholder
  // text (we deferred this until after inline rendering so that the
  // emitted `<b>` / `<i>` / `<a>` tags survive); then substitute each
  // placeholder with its wrapped, escaped body.
  const segments = splitOnPlaceholders(text);
  const parts = segments.map((seg) => {
    if (seg.kind === "text") return escapeNonTagText(seg.text);
    const re = new RegExp(`${PLACEHOLDER_PREFIX}(\\d+)${PLACEHOLDER_SUFFIX}`);
    const m = re.exec(seg.text);
    if (!m) return seg.text;
    const id = Number.parseInt(m[1] ?? "0", 10);
    const ph = store[id];
    if (!ph) return "";
    if (ph.kind === "inline_code") {
      return `<code>${escapeHtmlText(ph.body)}</code>`;
    }
    const language = ph.language ? ` class="language-${escapeHtmlAttr(ph.language)}"` : "";
    return `<pre><code${language}>${escapeHtmlText(ph.body)}</code></pre>`;
  });
  return parts.join("");
}

function escapeNonTagText(text: string): string {
  // Walk the string and escape `<`, `>`, `&` outside of the
  // tag-shaped tokens we emitted ourselves (`<b>`, `</b>`, `<i>`,
  // `<a href="...">`, etc.). A naive global escape would mangle the
  // `<a href="...">` we just produced; this preserves them.
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "<") {
      const tagEnd = findTagEnd(text, i);
      if (tagEnd > i && isAllowedTag(text.slice(i, tagEnd + 1))) {
        out += text.slice(i, tagEnd + 1);
        i = tagEnd + 1;
        continue;
      }
      out += "&lt;";
      i += 1;
      continue;
    }
    if (ch === ">") {
      out += "&gt;";
      i += 1;
      continue;
    }
    if (ch === "&") {
      out += "&amp;";
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function findTagEnd(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i += 1) {
    const c = text[i];
    if (c === ">") return i;
    if (c === "<") return -1;
  }
  return -1;
}

const ALLOWED_TAG_NAMES = new Set([
  "b",
  "i",
  "u",
  "s",
  "code",
  "pre",
  "a",
  "blockquote",
]);

function isAllowedTag(token: string): boolean {
  // `token` includes `<` and `>`. Accept plain `<b>`, `</b>`, and
  // `<a href="...">` shapes only — anything else (including
  // arbitrary attributes on non-`a` tags) is treated as plain text
  // and escaped.
  const m = /^<\/?([a-zA-Z]+)(?:\s+[^>]*)?>$/.exec(token);
  if (!m) return false;
  return ALLOWED_TAG_NAMES.has((m[1] ?? "").toLowerCase());
}
