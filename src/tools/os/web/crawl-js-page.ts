/**
 * Spot a page that is built by JavaScript (ATO-970): curl gets an HTML shell
 * with scripts and almost no text, and the real content appears only in a
 * browser. Crawlee's adaptive crawler makes the same call (plain HTTP first,
 * a browser only for pages that need one), and Firecrawl renders such pages
 * in a browser. `os.web.crawl` renders a few of them in the agent's own
 * browser when it can, and otherwise says which pages need it.
 */

/** Readable characters below which a page with scripts counts as a JS shell. */
export const JS_SHELL_MAX_TEXT = 200;

const MOUNT_POINT =
  /<(?:div|main|body|app-root)\b[^>]*\bid\s*=\s*["']?(?:root|app|__next|__nuxt|___gatsby|svelte|q-app|application|main-app)["'\s>]/i;
const NOSCRIPT_JS = /<noscript\b[^>]*>[\s\S]{0,2000}?javascript[\s\S]{0,2000}?<\/noscript>/i;

/**
 * True for an HTML page whose extracted text is nearly empty while the
 * markup carries scripts plus a sign of a client-rendered app: an app mount
 * point (`<div id="root">`, `__next`, ...), a `<noscript>` asking for
 * JavaScript, or several scripts. A short page with no scripts is just short.
 */
export function looksJsRendered(html: string, contentType: string, extractedText: string): boolean {
  if (!/html/i.test(contentType) && !/<html[\s>]/i.test(html.slice(0, 2_000))) return false;
  if (extractedText.replace(/\s+/g, " ").trim().length >= JS_SHELL_MAX_TEXT) return false;
  const scripts = html.match(/<script\b/gi)?.length ?? 0;
  if (scripts === 0) return false;
  return MOUNT_POINT.test(html) || NOSCRIPT_JS.test(html) || scripts >= 2;
}

/** The line the model reads for JS pages the crawl could not render. */
export function describeJsPages(urls: readonly string[]): string {
  const shown = urls.slice(0, 3).join(", ");
  const more = urls.length > 3 ? ` and ${urls.length - 3} more` : "";
  return (
    `${urls.length} page(s) are built by JavaScript and had almost no text without it: ${shown}${more}. ` +
    "To read one, open it with browser.navigate and read it with browser.read_aria " +
    "(or browser.extract for structured data)."
  );
}
