import type { CompressedToolResult } from "../../compressor/result-compressor.js";
import type { ToolContext, ToolRegistry } from "../tool-registry.js";
import type { ResearchBudgets } from "./research-args.js";
import type { ResearchModel } from "./research-model.js";
import type { Finding, SkippedSource } from "./research-types.js";

export const WEB_SEARCH_TOOL = "os.web.search";
export const WEB_FETCH_TOOL = "os.web.fetch";

/** The registry's own `invoke`: the web tools run with their approvals, offline mode and framing. */
export type ToolInvoker = Pick<ToolRegistry, "invoke" | "has">;

export interface FetchedPage {
  url: string;
  title?: string;
  text: string;
}

/**
 * Pages read in one run, by URL, shared by every sub-question: a page
 * two searches return is fetched once, and the run stops fetching at
 * `maxPages`. The text kept is what the quote check reads.
 */
export class PageCache {
  private readonly pages = new Map<string, Promise<FetchedPage | { error: string }>>();
  private readonly read = new Map<string, string>();
  constructor(private readonly maxPages: number) {}

  /** Pages read successfully so far. */
  get readCount(): number {
    return this.read.size;
  }

  textOf = (url: string): string | undefined => this.read.get(url);

  load(url: string, fetchPage: () => Promise<FetchedPage>): Promise<FetchedPage | { error: string }> | null {
    const known = this.pages.get(url);
    if (known) return known;
    if (this.pages.size >= this.maxPages) return null;
    const pending = fetchPage().then(
      (page) => {
        this.read.set(url, page.text);
        return page;
      },
      (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }),
    );
    this.pages.set(url, pending);
    return pending;
  }
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

function searchUrls(result: CompressedToolResult): Array<{ url: string; title?: string }> {
  const list = result.details.results;
  if (!Array.isArray(list)) return [];
  const out: Array<{ url: string; title?: string }> = [];
  for (const item of list) {
    if (item === null || typeof item !== "object") continue;
    const { url, title } = item as { url?: unknown; title?: unknown };
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) continue;
    out.push(typeof title === "string" && title.length > 0 ? { url, title } : { url });
  }
  return out;
}

/**
 * One sub-question: search, read the first pages not read yet, ask the
 * model for findings on each. A page that fails (an HTTP error, a bot
 * wall, a denied approval) is skipped and named; cancellation is not.
 */
export async function researchSubQuestion(input: {
  index: number;
  question: string;
  subQuestion: string;
  budgets: ResearchBudgets;
  tools: ToolInvoker;
  model: ResearchModel;
  pages: PageCache;
  ctx: ToolContext;
}): Promise<{ findings: Finding[]; skipped: SkippedSource[] }> {
  const { index, budgets, tools, model, pages, ctx } = input;
  const findings: Finding[] = [];
  const skipped: SkippedSource[] = [];
  const skip = (target: string, reason: string): void => {
    skipped.push({ subQuestion: index, target, reason });
  };
  ctx.signal.throwIfAborted();
  let search: CompressedToolResult;
  try {
    search = await tools.invoke(WEB_SEARCH_TOOL, { query: input.subQuestion, maxResults: budgets.pagesPerQuestion + 3 }, ctx);
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    skip(`search "${input.subQuestion}"`, (err as Error).message);
    return { findings, skipped };
  }
  if (search.status === "error") {
    skip(`search "${input.subQuestion}"`, firstLine(search.summary));
    return { findings, skipped };
  }
  let used = 0;
  for (const hit of searchUrls(search)) {
    if (used >= budgets.pagesPerQuestion) break;
    const pending = pages.load(hit.url, () => fetchPage(hit, budgets, tools, ctx));
    if (pending === null) {
      skip(hit.url, `page budget of ${budgets.maxPages} used up`);
      break;
    }
    const page = await pending;
    ctx.signal.throwIfAborted();
    used++;
    if ("error" in page) {
      skip(hit.url, page.error);
      continue;
    }
    let read: Array<{ claim: string; quote: string }>;
    try {
      read = await model.findings(
        {
          question: input.question,
          subQuestion: input.subQuestion,
          url: page.url,
          ...(page.title !== undefined ? { title: page.title } : {}),
          text: page.text.slice(0, budgets.modelPageChars),
          max: budgets.findingsPerPage,
        },
        ctx.signal,
      );
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      skip(hit.url, `the model could not read it: ${(err as Error).message}`);
      continue;
    }
    for (const f of read) {
      findings.push({ subQuestion: index, claim: f.claim, quote: f.quote, url: page.url, ...(page.title !== undefined ? { title: page.title } : {}) });
    }
  }
  return { findings, skipped };
}

async function fetchPage(
  hit: { url: string; title?: string },
  budgets: ResearchBudgets,
  tools: ToolInvoker,
  ctx: ToolContext,
): Promise<FetchedPage> {
  const result = await tools.invoke(WEB_FETCH_TOOL, { url: hit.url, extractMode: "text", maxChars: budgets.pageChars }, ctx);
  if (result.status === "error") throw new Error(firstLine(result.summary));
  const title = typeof result.details.title === "string" && result.details.title.length > 0 ? result.details.title : hit.title;
  return { url: hit.url, ...(title !== undefined ? { title } : {}), text: resultText(result).slice(0, budgets.pageChars * 2) };
}

/** First meaningful line of a summary, past the untrusted framing. */
function firstLine(summary: string): string {
  const line = summary
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("[external content") && !l.startsWith("<<<"));
  return (line ?? "failed").slice(0, 200);
}
