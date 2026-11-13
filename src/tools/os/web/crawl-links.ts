/**
 * Where a crawl can go next (ATO-700): links out of a fetched page and page
 * URLs out of a sitemap. Pure functions over text, no network.
 */
import { parseHTML } from "linkedom";

/** File types a page crawl never wants: the reader would get binary noise. */
const SKIPPED_EXTENSIONS =
  /\.(?:png|jpe?g|gif|webp|svg|ico|bmp|tiff?|avif|mp[34]|m4a|wav|ogg|webm|mov|avi|mkv|zip|gz|tgz|bz2|xz|7z|rar|tar|dmg|exe|msi|pkg|deb|rpm|apk|iso|woff2?|ttf|otf|eot|css|js|mjs|map|wasm|pdf|docx?|xlsx?|pptx?)$/i;

/** Normalise a crawl URL: no fragment, default port dropped by `URL` itself. */
export function normaliseCrawlUrl(url: URL): string {
  const copy = new URL(url.toString());
  copy.hash = "";
  return copy.toString();
}

/**
 * Is `candidate` inside the crawl's scope: http(s), same origin as the
 * start page, under `pathPrefix` when one is given, and not a file type the
 * reader cannot use?
 */
export function inCrawlScope(candidate: URL, start: URL, pathPrefix: string | null): boolean {
  if (candidate.protocol !== "http:" && candidate.protocol !== "https:") return false;
  if (candidate.origin !== start.origin) return false;
  if (pathPrefix !== null && !candidate.pathname.startsWith(pathPrefix)) return false;
  return !SKIPPED_EXTENSIONS.test(candidate.pathname);
}

export interface PageLinks {
  links: URL[];
  /** `<meta name="robots" content="nofollow">` on the page: its links are not followed. */
  nofollow: boolean;
}

function resolveHref(href: string, base: URL): URL | null {
  const trimmed = href.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) return null;
  if (/^(?:mailto|tel|javascript|data):/i.test(trimmed)) return null;
  try {
    return new URL(trimmed, base);
  } catch {
    return null;
  }
}

/** Links from an HTML page, honouring `<base href>`, `rel="nofollow"` and the robots meta tag. */
export function extractHtmlLinks(html: string, pageUrl: URL): PageLinks {
  let document: ReturnType<typeof parseHTML>["document"];
  try {
    document = parseHTML(html).document;
  } catch {
    return { links: [], nofollow: false };
  }
  const robotsMeta = Array.from(document.querySelectorAll("meta[name]"))
    .filter((m) => /^(?:robots|atomic-agent)$/i.test(m.getAttribute("name") ?? ""))
    .map((m) => (m.getAttribute("content") ?? "").toLowerCase());
  const nofollow = robotsMeta.some((c) => /\b(?:nofollow|none)\b/.test(c));
  if (nofollow) return { links: [], nofollow: true };

  let base = pageUrl;
  const baseHref = document.querySelector("base[href]")?.getAttribute("href");
  if (baseHref) base = resolveHref(baseHref, pageUrl) ?? pageUrl;

  const links: URL[] = [];
  for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
    const rel = (anchor.getAttribute("rel") ?? "").toLowerCase();
    if (/\bnofollow\b/.test(rel)) continue;
    const url = resolveHref(anchor.getAttribute("href") ?? "", base);
    if (url) links.push(url);
  }
  return { links, nofollow: false };
}

/** Links from a Markdown page (what a "Markdown for Agents" server sends instead of HTML). */
export function extractMarkdownLinks(markdown: string, pageUrl: URL): PageLinks {
  const links: URL[] = [];
  // Inline links `[text](url "title")`, then reference definitions `[id]: url`.
  for (const match of markdown.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    const url = resolveHref(match[1] ?? "", pageUrl);
    if (url) links.push(url);
  }
  for (const match of markdown.matchAll(/^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/gm)) {
    const url = resolveHref(match[1] ?? "", pageUrl);
    if (url) links.push(url);
  }
  return { links, nofollow: false };
}

export function extractPageLinks(body: string, contentType: string, pageUrl: URL): PageLinks {
  const ct = contentType.toLowerCase().split(";")[0]?.trim() ?? "";
  if (ct === "text/markdown") return extractMarkdownLinks(body, pageUrl);
  if (ct.includes("html") || /<a\s/i.test(body.slice(0, 200_000))) return extractHtmlLinks(body, pageUrl);
  return { links: [], nofollow: false };
}

export interface SitemapEntries {
  /** Page URLs from a `<urlset>`. */
  pages: string[];
  /** Child sitemaps from a `<sitemapindex>`. */
  sitemaps: string[];
}

/** A numeric character reference, or the reference itself when it names no character. */
function codePoint(n: number, original: string): string {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : original;
}

function decodeXmlText(text: string): string {
  return text
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, d: string) => codePoint(Number(d), m))
    .replace(/&#x([0-9a-f]+);/gi, (m, h: string) => codePoint(Number.parseInt(h, 16), m))
    .replace(/&amp;/g, "&")
    .trim();
}

/** `<loc>` entries of a sitemap or sitemap index. Anything that is not one yields nothing. */
export function parseSitemap(xml: string): SitemapEntries {
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const locs: string[] = [];
  for (const match of xml.matchAll(/<(?:[a-z0-9]+:)?loc>\s*([\s\S]*?)\s*<\/(?:[a-z0-9]+:)?loc>/gi)) {
    const value = decodeXmlText(match[1] ?? "");
    if (/^https?:\/\//i.test(value)) locs.push(value);
  }
  return isIndex ? { pages: [], sitemaps: locs } : { pages: locs, sitemaps: [] };
}
