import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { marked } from "marked";
import TurndownService from "turndown";
import { convertHtmlToText, looksLikeHtml } from "./html-to-text.js";

export type ExtractMode = "markdown" | "text";

/** Which path produced the extracted content (for tool-result diagnostics). */
export type Extractor =
  | "cf-markdown"
  | "defuddle"
  | "readability"
  | "basic"
  | "raw";

/**
 * Which main-content extractor runs first on an HTML page
 * (`web.fetch.extractor`). `"readability"` is the shipped default; with
 * `"defuddle"` Defuddle runs first and Readability is the fallback.
 */
export type HtmlExtractorPreference = "readability" | "defuddle";

export interface ExtractResult {
  text: string;
  title?: string;
  extractor: Extractor;
}

export interface ExtractWebContentParams {
  body: string;
  contentType: string | null | undefined;
  url: string;
  mode: ExtractMode;
}

export interface ExtractWebContentAsyncParams extends ExtractWebContentParams {
  /** Main-content extractor to try first on HTML. Default `"readability"`. */
  preferred?: HtmlExtractorPreference;
  /**
   * Injectable Defuddle runner for tests; defaults to the lazily loaded
   * `defuddle/node` package.
   */
  runDefuddle?: DefuddleRunner;
}

/**
 * Runs Defuddle over a parsed page. Returns cleaned main-content HTML or
 * markdown (per `markdown`), or `null` when nothing was found.
 */
export type DefuddleRunner = (input: {
  html: string;
  url: string;
  markdown: boolean;
}) => Promise<{ content: string; title?: string } | null>;

let turndown: TurndownService | null = null;

function htmlToMarkdown(html: string): string {
  turndown ??= new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  return turndown.turndown(html).trim();
}

function markdownToPlain(markdown: string): string {
  const html = marked.parse(markdown, { async: false }) as string;
  return convertHtmlToText(html);
}

function stripScriptStyle(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
}

/**
 * Main-content extraction via Mozilla Readability over a linkedom DOM.
 * Returns `null` when Readability cannot find an article body so the
 * caller can fall back to a basic tag-stripping path.
 */
function tryReadability(
  html: string,
  url: string,
  mode: ExtractMode,
): { text: string; title?: string } | null {
  try {
    const { document } = parseHTML(html);
    try {
      (document as { baseURI?: string }).baseURI = url;
    } catch {
      // Best-effort base URI for resolving relative links.
    }
    const reader = new Readability(
      document as unknown as ConstructorParameters<typeof Readability>[0],
      { charThreshold: 0 },
    );
    const parsed = reader.parse();
    if (!parsed?.content) return null;
    const title = parsed.title || undefined;
    if (mode === "text") {
      const text = (parsed.textContent ?? "").replace(/[ \t]+\n/g, "\n").trim();
      return text ? { text, title } : null;
    }
    const md = htmlToMarkdown(parsed.content);
    return md ? { text: md, title } : null;
  } catch {
    return null;
  }
}

/**
 * Defuddle must never reach the network on its own: by default its "async
 * extractors" call third-party APIs (YouTube transcripts, Reddit comments)
 * when a page has no local content. `os.web.fetch` has already fetched the
 * page through the SSRF guard, so extraction stays offline.
 */
const refuseFetch: typeof globalThis.fetch = () =>
  Promise.reject(new Error("os.web.fetch: Defuddle may not fetch"));

type DefuddleNodeModule = typeof import("defuddle/node");
let defuddleModule: Promise<DefuddleNodeModule> | null = null;

/**
 * The package is ~2.7 MB, so it is loaded on first use and only when
 * `web.fetch.extractor` is `"defuddle"`.
 */
const defaultRunDefuddle: DefuddleRunner = async ({ html, url, markdown }) => {
  defuddleModule ??= import("defuddle/node");
  const { Defuddle } = await defuddleModule;
  const { document } = parseHTML(html);
  const result = await Defuddle(
    document as unknown as Parameters<typeof Defuddle>[0],
    url,
    { markdown, useAsync: false, fetch: refuseFetch },
  );
  const content = (result.content ?? "").trim();
  if (!content || !(result.wordCount > 0)) return null;
  return { content, title: result.title || undefined };
};

/** Defuddle → markdown or plain text, or `null` to fall back. */
async function tryDefuddle(
  html: string,
  url: string,
  mode: ExtractMode,
  run: DefuddleRunner,
): Promise<{ text: string; title?: string } | null> {
  try {
    const parsed = await run({ html, url, markdown: mode === "markdown" });
    if (!parsed) return null;
    const text =
      mode === "markdown" ? parsed.content : convertHtmlToText(parsed.content);
    return text.trim() ? { text: text.trim(), title: parsed.title } : null;
  } catch {
    return null;
  }
}

/**
 * `extractWebContent` with a choice of main-content extractor (ATO-698).
 * With `preferred: "defuddle"` an HTML page goes through Defuddle first
 * (keeps code blocks, math and tables in markdown); when Defuddle throws or
 * finds no content the usual Readability → basic chain runs. Every other
 * input, and the default `"readability"`, behaves exactly like
 * `extractWebContent`.
 */
export async function extractWebContentAsync(
  params: ExtractWebContentAsyncParams,
): Promise<ExtractResult> {
  const { preferred = "readability", runDefuddle = defaultRunDefuddle } =
    params;
  if (
    preferred === "defuddle" &&
    !isMarkdownType(params.contentType) &&
    looksLikeHtml(params.contentType, params.body)
  ) {
    const defuddled = await tryDefuddle(
      params.body,
      params.url,
      params.mode,
      runDefuddle,
    );
    if (defuddled) return { ...defuddled, extractor: "defuddle" };
  }
  return extractWebContent(params);
}

function isMarkdownType(contentType: string | null | undefined): boolean {
  return (
    (contentType ?? "").toLowerCase().split(";")[0]?.trim() === "text/markdown"
  );
}

/**
 * Turn a fetched response body into LLM-friendly text or markdown.
 *
 * Priority order mirrors the OpenClaw web-fetch pipeline:
 *  1. `cf-markdown` — server already returned `text/markdown` (Cloudflare
 *     "Markdown for Agents" or an origin that negotiates markdown). The
 *     body is used as-is; `text` mode strips it to plain text.
 *  2. `readability` — HTML response → Mozilla Readability main-content
 *     extraction → turndown (markdown) or `textContent` (text).
 *  3. `basic` — Readability failed: strip `<script>`/`<style>` then
 *     turndown (markdown) or `html-to-text` (text).
 *  4. `raw` — non-HTML, non-markdown payload (JSON, plain text) returned
 *     untouched.
 */
export function extractWebContent(
  params: ExtractWebContentParams,
): ExtractResult {
  const { body, contentType, url, mode } = params;

  if (isMarkdownType(contentType)) {
    return {
      text: mode === "text" ? markdownToPlain(body) : body.trim(),
      extractor: "cf-markdown",
    };
  }

  if (looksLikeHtml(contentType, body)) {
    const readable = tryReadability(body, url, mode);
    if (readable) {
      return { ...readable, extractor: "readability" };
    }
    const stripped = stripScriptStyle(body);
    return {
      text:
        mode === "markdown"
          ? htmlToMarkdown(stripped)
          : convertHtmlToText(stripped),
      extractor: "basic",
    };
  }

  return { text: body.trim(), extractor: "raw" };
}
