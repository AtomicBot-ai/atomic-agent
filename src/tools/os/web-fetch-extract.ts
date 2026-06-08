import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { marked } from "marked";
import TurndownService from "turndown";
import { convertHtmlToText, looksLikeHtml } from "./html-to-text.js";

export type ExtractMode = "markdown" | "text";

/** Which path produced the extracted content (for tool-result diagnostics). */
export type Extractor = "cf-markdown" | "readability" | "basic" | "raw";

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
export function extractWebContent(params: ExtractWebContentParams): ExtractResult {
  const { body, contentType, url, mode } = params;
  const ct = (contentType ?? "").toLowerCase();

  if (ct.split(";")[0]?.trim() === "text/markdown") {
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
      text: mode === "markdown" ? htmlToMarkdown(stripped) : convertHtmlToText(stripped),
      extractor: "basic",
    };
  }

  return { text: body.trim(), extractor: "raw" };
}
