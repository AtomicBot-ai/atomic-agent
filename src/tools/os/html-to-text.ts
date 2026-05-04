import { convert as htmlToTextConvert } from "html-to-text";

/**
 * Whitespace-trimmed prefixes that flag a payload as HTML even when the
 * remote server omitted the `text/html` content-type. Sniffing is
 * deliberately conservative: we only want HTML pages to be stripped, never
 * JSON documents that happen to contain `<` characters.
 */
const HTML_BODY_SNIFF_PREFIXES = [
  "<!doctype html",
  "<html",
  "<?xml",
  "<rss",
];

/**
 * Decide whether to strip tags from this response body. Trusts
 * `content-type` first (case-insensitive prefix match against the known
 * HTML/XHTML/XML media types) and only falls back to a body sniff when
 * the header is missing or generic (`application/octet-stream`,
 * `text/plain`, …) so well-typed JSON responses never accidentally hit
 * the converter.
 */
export function looksLikeHtml(
  contentType: string | null | undefined,
  body: string,
): boolean {
  const ct = (contentType ?? "").toLowerCase().split(";")[0]?.trim() ?? "";
  if (
    ct === "text/html" ||
    ct === "application/xhtml+xml" ||
    ct === "application/xml" ||
    ct === "text/xml"
  ) {
    return true;
  }
  if (ct.length > 0 && ct !== "application/octet-stream" && ct !== "text/plain") {
    return false;
  }
  const head = body.trimStart().slice(0, 32).toLowerCase();
  return HTML_BODY_SNIFF_PREFIXES.some((prefix) => head.startsWith(prefix));
}

/**
 * Convert an HTML document into LLM-friendly plain text.
 *
 * Defaults are tuned for tool-result consumption rather than human reading:
 * `<script>` / `<style>` / `<noscript>` / `<head>` / `<nav>` / `<footer>`
 * are dropped wholesale; links keep their visible text but the bracketed
 * `[href]` suffix is omitted to keep the prompt budget tight; images
 * collapse to their `alt` text only; word-wrapping is disabled because
 * the agent loop uses character-based caps, not column width. The
 * underlying parser tolerates malformed HTML — broken markup falls
 * through as-is.
 */
export function convertHtmlToText(html: string): string {
  return htmlToTextConvert(html, {
    wordwrap: false,
    selectors: [
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
      { selector: "noscript", format: "skip" },
      { selector: "head", format: "skip" },
      { selector: "nav", format: "skip" },
      { selector: "footer", format: "skip" },
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
    ],
  }).trim();
}
