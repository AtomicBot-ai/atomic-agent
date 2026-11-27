import { basename } from "node:path";
import type { CompressedToolResult } from "../../compressor/result-compressor.js";
import { fileUrlFor } from "../files/file-cite.js";
import type { ToolContext, ToolRegistry } from "../tool-registry.js";
import type { ResearchBudgets } from "./research-args.js";

export const WEB_SEARCH_TOOL = "os.web.search";
export const WEB_FETCH_TOOL = "os.web.fetch";
export const FILES_SEARCH_TOOL = "files.search";

/** The registry's own `invoke`: the tools run with their approvals, read scope, offline mode and framing. */
export type ToolInvoker = Pick<ToolRegistry, "invoke" | "has">;

export interface FetchedPage {
  url: string;
  title?: string;
  /** What the quote check reads. */
  text: string;
  /** What the reading model sees, when it is not the start of `text` (a long document, near its hit). */
  modelText?: string;
}

/** One search hit: `key` is the page cache key and the report's link. */
export interface SourceHit {
  key: string;
  title?: string;
  /** Documents: the file, its PDF page and the matched snippet. */
  path?: string;
  page?: number;
  snippet?: string;
}

/**
 * Where a run looks (ATO-2507): the web through `os.web.search` /
 * `os.web.fetch`, or the folders in My files through `files.search`.
 * `search` and `read` throw with a plain reason on a failure; the
 * caller names it under "Sources not read".
 */
export interface ResearchSource {
  readonly kind: "web" | "documents";
  /** How a failed search is named in the report. */
  searchLabel(query: string): string;
  search(query: string, max: number, ctx: ToolContext): Promise<SourceHit[]>;
  read(hit: SourceHit, ctx: ToolContext): Promise<FetchedPage>;
}

const FRAME_LINE = /^(?:\[external content from [^\]]*\]|<<<(?:END )?UNTRUSTED [A-Z ]+ [0-9a-f]{16}>>>)$/;

/**
 * The page text out of a tool result: the uncut copy when the registry
 * kept one, without the registry's framing lines, so a quote of the
 * framing itself ("data to read, not instructions") is not on the page.
 */
export function resultText(result: CompressedToolResult): string {
  return (result.fullOutput ?? result.summary)
    .split("\n")
    .filter((line) => !FRAME_LINE.test(line.trim()))
    .join("\n");
}

/** First meaningful line of a summary, past the untrusted framing. */
export function firstLine(summary: string): string {
  const line = summary
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("[external content") && !l.startsWith("<<<"));
  return (line ?? "failed").slice(0, 200);
}

function hitList(result: CompressedToolResult, field: "results" | "hits"): Array<Record<string, unknown>> {
  const list = result.details[field];
  if (!Array.isArray(list)) return [];
  return list.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object");
}

export function createWebSource(tools: ToolInvoker, budgets: ResearchBudgets): ResearchSource {
  return {
    kind: "web",
    searchLabel: (query) => `search "${query}"`,
    async search(query, max, ctx) {
      const result = await tools.invoke(WEB_SEARCH_TOOL, { query, maxResults: max + 3 }, ctx);
      if (result.status === "error") throw new Error(firstLine(result.summary));
      const out: SourceHit[] = [];
      for (const { url, title } of hitList(result, "results")) {
        if (typeof url !== "string" || !/^https?:\/\//i.test(url)) continue;
        out.push(typeof title === "string" && title.length > 0 ? { key: url, title } : { key: url });
      }
      return out;
    },
    async read(hit, ctx) {
      const result = await tools.invoke(WEB_FETCH_TOOL, { url: hit.key, extractMode: "text", maxChars: budgets.pageChars }, ctx);
      if (result.status === "error") throw new Error(firstLine(result.summary));
      const title = typeof result.details.title === "string" && result.details.title.length > 0 ? result.details.title : hit.title;
      return { url: hit.key, ...(title !== undefined ? { title } : {}), text: resultText(result).slice(0, budgets.pageChars * 2) };
    },
  };
}

/** The index's own text of a file (or one PDF page of it); `null` when it is not indexed now. */
export interface DocumentPassages {
  passageText(path: string, page?: number): string | null;
}

/**
 * Research over My files (ATO-2507): `files.search` through the
 * registry (its read scope and guest rules apply to `folder`), then the
 * indexed text of each hit's file or PDF page as the "page" the quote
 * is checked against. Nothing goes online.
 */
export function createDocumentSource(
  tools: ToolInvoker,
  passages: DocumentPassages,
  budgets: ResearchBudgets,
  folder?: string,
): ResearchSource {
  return {
    kind: "documents",
    searchLabel: (query) => `document search "${query}"`,
    async search(query, max, ctx) {
      const result = await tools.invoke(FILES_SEARCH_TOOL, { query, topK: max + 3, ...(folder !== undefined ? { folder } : {}) }, ctx);
      if (result.status === "error") throw new Error(firstLine(result.summary));
      const out: SourceHit[] = [];
      for (const { path, page, timeSec, snippet } of hitList(result, "hits")) {
        if (typeof path !== "string" || path.length === 0) continue;
        const onPage = typeof page === "number" && Number.isInteger(page) && page > 0 ? page : undefined;
        const at = onPage === undefined && typeof timeSec === "number" && Number.isFinite(timeSec) && timeSec >= 0 ? Math.floor(timeSec) : undefined;
        const key = `${fileUrlFor(path)}${onPage !== undefined ? `#page=${onPage}` : at !== undefined ? `#t=${at}` : ""}`;
        // Two passages of one page are one page to read.
        if (out.some((h) => h.key === key)) continue;
        out.push({
          key,
          title: onPage !== undefined ? `${basename(path)}, p. ${onPage}` : basename(path),
          path,
          ...(onPage !== undefined ? { page: onPage } : {}),
          ...(typeof snippet === "string" ? { snippet } : {}),
        });
      }
      return out;
    },
    async read(hit) {
      const text = hit.path === undefined ? null : passages.passageText(hit.path, hit.page);
      if (text === null || text.trim().length === 0) {
        throw new Error("this passage is no longer in My files (the file changed or its folder was removed)");
      }
      return {
        url: hit.key,
        ...(hit.title !== undefined ? { title: hit.title } : {}),
        text,
        ...(text.length > budgets.modelPageChars ? { modelText: focusText(text, hit.snippet ?? "", budgets.modelPageChars) } : {}),
      };
    },
  };
}

/**
 * `max` characters of a long document around its search snippet, so
 * the model reads the part that matched rather than the first pages.
 * The snippet's markers (`«»`, `…`) are dropped; its longest piece is
 * looked up, ignoring case. Not found: the start of the text.
 */
export function focusText(text: string, snippet: string, max: number): string {
  if (text.length <= max) return text;
  const piece = snippet
    .replace(/[«»]/g, "")
    .split(/…|\.\.\./)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .sort((x, y) => y.length - x.length)[0] ?? "";
  const words = piece.split(" ").slice(0, 6).filter((w) => w.length > 0);
  if (words.join(" ").length < 8) return text.slice(0, max);
  // Any run of whitespace in the text matches the snippet's one space.
  const probe = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "i");
  const at = text.search(probe);
  if (at < 0) return text.slice(0, max);
  const start = Math.max(0, Math.min(text.length - max, at - Math.floor(max / 3)));
  return text.slice(start, start + max);
}
