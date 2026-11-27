import type { ToolContext } from "../tool-registry.js";
import type { ResearchBudgets } from "./research-args.js";
import type { ResearchModel } from "./research-model.js";
import type { FetchedPage, ResearchSource } from "./research-sources.js";
import type { Finding, SkippedSource } from "./research-types.js";

export {
  FILES_SEARCH_TOOL,
  resultText,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
  type FetchedPage,
  type ToolInvoker,
} from "./research-sources.js";

/**
 * Pages read in one run, by key (a URL, or a document's cited
 * `file://` URL), shared by every sub-question and source: a page two
 * searches return is read once, and the run stops reading at
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

/**
 * One sub-question on one source: search, read the first pages not read
 * yet, ask the model for findings on each. A page that fails (an HTTP
 * error, a bot wall, a denied approval, a passage gone from the index)
 * is skipped and named; cancellation is not. `timeUp` (the run's
 * `maxMinutes`) stops it before the next search or page; `cut` says so.
 */
export async function researchSubQuestion(input: {
  index: number;
  question: string;
  subQuestion: string;
  budgets: ResearchBudgets;
  source: ResearchSource;
  model: ResearchModel;
  pages: PageCache;
  ctx: ToolContext;
  timeUp?: () => boolean;
}): Promise<{ findings: Finding[]; skipped: SkippedSource[]; cut: boolean }> {
  const { index, budgets, source, model, pages, ctx } = input;
  const timeUp = input.timeUp ?? (() => false);
  const findings: Finding[] = [];
  const skipped: SkippedSource[] = [];
  const skip = (target: string, reason: string): void => {
    skipped.push({ subQuestion: index, target, reason });
  };
  ctx.signal.throwIfAborted();
  if (timeUp()) return { findings, skipped, cut: true };
  let hits: Awaited<ReturnType<ResearchSource["search"]>>;
  try {
    hits = await source.search(input.subQuestion, budgets.pagesPerQuestion, ctx);
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    skip(source.searchLabel(input.subQuestion), (err as Error).message);
    return { findings, skipped, cut: false };
  }
  let used = 0;
  for (const hit of hits) {
    if (used >= budgets.pagesPerQuestion) break;
    if (timeUp()) return { findings, skipped, cut: true };
    const pending = pages.load(hit.key, () => source.read(hit, ctx));
    if (pending === null) {
      skip(hit.key, `page budget of ${budgets.maxPages} used up`);
      break;
    }
    const page = await pending;
    ctx.signal.throwIfAborted();
    used++;
    if ("error" in page) {
      skip(hit.key, page.error);
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
          text: (page.modelText ?? page.text).slice(0, budgets.modelPageChars),
          max: budgets.findingsPerPage,
          kind: source.kind,
        },
        ctx.signal,
      );
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      skip(hit.key, `the model could not read it: ${(err as Error).message}`);
      continue;
    }
    for (const f of read) {
      findings.push({ subQuestion: index, claim: f.claim, quote: f.quote, url: page.url, ...(page.title !== undefined ? { title: page.title } : {}) });
    }
  }
  return { findings, skipped, cut: false };
}
