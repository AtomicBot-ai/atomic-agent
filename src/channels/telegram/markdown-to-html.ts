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
  const re = new RegExp(
    `${PLACEHOLDER_PREFIX}(\\d+)${PLACEHOLDER_SUFFIX}`,
    "g",
  );
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
  return s.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_match, label: string, url: string) => {
      if (!SAFE_URL_SCHEME.test(url)) {
        return `${escapeHtmlText(label)} (${escapeHtmlText(url)})`;
      }
      return `<a href="${escapeHtmlAttr(url)}">${applyEmphasis(label)}</a>`;
    },
  );
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
  // A single `*` or `_` opens emphasis only when it is not glued to a
  // letter or digit on the outside and not followed by whitespace on
  // the inside; the closing delimiter is the mirror image. Both
  // conditions matter, and each covers a different half of the
  // reported bug:
  //
  //  - The word guard keeps `20*log10(abs(15-1*25))` literal. Without
  //    it the two loose asterisks are read as an emphasis pair and the
  //    line comes out as `20<i>log10(abs(15-1</i>25))`; under
  //    `parse_mode: "HTML"` Telegram renders that as italics, so the
  //    asterisks are *deleted* from what the operator sees and the
  //    expression silently changes meaning. Restyling is recoverable;
  //    character loss is not.
  //  - The whitespace guard keeps the spaced form of the same
  //    arithmetic literal — `G_cont = G1 * G2 * G3`, `2 * pi * 5`,
  //    Octave's `A .* B .* C`, `SELECT * FROM t`. There the outer
  //    flanks are punctuation or spaces, so the word guard alone lets
  //    the pair through.
  //
  // Deliberate divergence from CommonMark, in both directions:
  //
  //  - Stricter. CommonMark allows intraword emphasis with `*` (and
  //    only with `*`; `_` is guarded there precisely so that
  //    `snake_case` survives), so upstream `*Note*s` and
  //    `un*frigging*believable` are `<em>` and here they stay
  //    literal. That asymmetry is intentional in the spec, and we are
  //    overriding it on purpose: in an agent transcript a `*` wedged
  //    between two word characters is arithmetic or a glob far more
  //    often than it is emphasis, and guessing wrong destroys
  //    characters rather than merely dropping a style.
  //  - Looser. This is a flanking approximation, not CommonMark's
  //    left/right-flanking algorithm. A pair flanked on the outside
  //    by punctuation — `rm build/*.o obj/*.o` — is still read as
  //    emphasis. CommonMark emphasises that one too, so it is not a
  //    divergence in itself, but the general punctuation case is only
  //    approximated; closing it means porting the whole algorithm.
  //
  // Both rules use Unicode letter/number classes rather than `\w`,
  // which is ASCII-only in JS. With `\w` the guards silently stopped
  // applying to non-Latin prose: `пи*2*пи` was emphasised where
  // `pi*2*pi` was not, and `слово_это_слово` lost its underscores
  // where `snake_case_name` kept them.
  //
  // `renderBold` has already consumed `**pairs**`, so the remaining
  // `*` runs here are single delimiters; the closing lookahead still
  // rejects a trailing `*` so a stray third asterisk is never
  // stranded next to an emitted `<i>`.
  //
  // `tagsBalanced` is the safety net rather than a style rule: earlier
  // passes have already emitted `<b>` / `<s>` / `<a>` into this
  // string, and a marker soup like `__* *a__*` can otherwise place an
  // `<i>` that crosses one of them. Telegram answers crossing tags
  // with a 400 on the whole `sendMessage` — the outbound sender
  // recovers by re-sending as plain text, but that costs the operator
  // every bit of formatting in the reply — so a candidate whose body
  // does not close what it opens stays literal instead.
  return s
    .replace(
      /(^|[^*\p{L}\p{N}_])\*([^*\s](?:[^*\n]*?[^*\s])?)\*(?![\p{L}\p{N}_*])/gu,
      (match: string, before: string, body: string) =>
        tagsBalanced(body) ? `${before}<i>${body}</i>` : match,
    )
    .replace(
      /(^|[^_\p{L}\p{N}])_([^_\s](?:[^_\n]*?[^_\s])?)_(?![\p{L}\p{N}_])/gu,
      (match: string, before: string, body: string) =>
        tagsBalanced(body) ? `${before}<i>${body}</i>` : match,
    );
}

/**
 * True when every HTML tag inside an emphasis candidate's body is
 * opened and closed within that body. Used to refuse a `<i>` wrapper
 * that would cross a `<b>` / `<s>` / `<a>` emitted by an earlier
 * inline pass, which Telegram rejects with a 400.
 */
function tagsBalanced(body: string): boolean {
  const stack: string[] = [];
  for (const m of body.matchAll(/<(\/?)([a-z-]+)[^>]*>/g)) {
    if (m[1] === "/") {
      if (stack.pop() !== m[2]) return false;
    } else {
      stack.push(m[2] ?? "");
    }
  }
  return stack.length === 0;
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
    const language = ph.language
      ? ` class="language-${escapeHtmlAttr(ph.language)}"`
      : "";
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
