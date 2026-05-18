import type {
  MemoryContext,
  MemoryContextProvider,
  MemoryContextProviderInput,
} from "../agent/agent-loop.js";
import type { AgentMetrics } from "../tracing/agent-metrics.js";
import type { LinkStore } from "./links/link-store.js";
import type {
  MemoryEntry,
  MemoryIndexEntry,
  MemoryStore,
} from "./memory-store.js";

/**
 * Configuration for the default memory context provider.
 *
 * `recall.k` / `recall.enabled` drive the `### recalled` section
 * (top-K BM25 notes against the current user message and recent tool
 * observations).
 * `index.limit` / `index.enabled` drive the `### memory-index` section
 * (compact pointer rows). Both are passed through to the renderer via
 * the agent loop's ephemeral session fields.
 *
 * `links.*` is the memory-v2 phase 2 graph expansion. When enabled,
 * the BFS-expanded ids are hydrated into MemoryEntry rows and folded
 * into `recalled` (after the BM25/cosine hits, so the original ranking
 * is preserved at the head of the list). Duplicates are filtered.
 *
 * The provider deduplicates: any id present in `recalled` (including
 * link-expanded ids) is filtered out of `index`, so the two sections
 * never repeat the same note.
 */
export interface DefaultMemoryContextProviderOptions {
  store: MemoryStore;
  recall: {
    enabled: boolean;
    k: number;
  };
  index: {
    enabled: boolean;
    limit: number;
    previewChars: number;
  };
  /**
   * Memory-v2 phase 2. Optional link-graph expansion. When `store` is
   * undefined or `enabled` is false, the recall stays byte-identical
   * to phase 1B output.
   */
  links?: {
    enabled: boolean;
    store: LinkStore;
    depth: number;
    maxExpanded: number;
  };
  /** Metrics sink for `agent.memory.link_expansion.hits`. */
  metrics?: AgentMetrics;
  /**
   * Optional working-directory scope. When set, both recall and index
   * are restricted to entries that carry the same `workingDir`; unset
   * means "any project". Matches `memory.notes.recall`'s semantics.
   */
  workingDir?: string | null;
}

/**
 * Read-side counterpart of the reflection runner: the loop calls this
 * once per turn to pre-fetch the `### recalled` and `### memory-index`
 * payloads injected into the prompt tail.
 *
 * Design goals:
 *  - Zero prompt contact on disabled features (`recall.enabled=false`
 *    or `index.enabled=false` yields empty arrays; the renderer then
 *    omits the corresponding section entirely).
 *  - Never throws: partial failures (e.g. BM25 query returning zero
 *    rows) leave the other channel intact.
 *  - Deterministic ordering: BM25 rank for recalled, then BFS-order
 *    link expansion, then `updated_at DESC` for index, deduplication
 *    by id.
 */
export function createDefaultMemoryContextProvider(
  opts: DefaultMemoryContextProviderOptions,
): MemoryContextProvider {
  return {
    async buildMemoryContext(
      input: MemoryContextProviderInput,
    ): Promise<MemoryContext> {
      const recalledBase = opts.recall.enabled
        ? await loadRecalled({
            store: opts.store,
            k: opts.recall.k,
            query: buildRecallQuery(input),
            workingDir: opts.workingDir,
          })
        : [];
      const recalled = expandWithLinks({
        store: opts.store,
        base: recalledBase,
        links: opts.links,
        metrics: opts.metrics,
      });
      const recalledIds = new Set(recalled.map((e) => e.id));
      const index = opts.index.enabled
        ? loadIndex({
            store: opts.store,
            limit: opts.index.limit,
            previewChars: opts.index.previewChars,
            workingDir: opts.workingDir,
            excludeIds: recalledIds,
          })
        : [];
      return { recalled, index };
    },
  };
}

interface LoadRecalledArgs {
  store: MemoryStore;
  k: number;
  query: string;
  workingDir: string | null | undefined;
}

/**
 * Memory-v2 phase 1B. Always goes through `recallHybridAsync` — when
 * embeddings are not attached, the implementation falls through to
 * the same BM25 path as before, so this stays observably identical
 * for phase 1A callers. The async hop is essentially a no-op when
 * the embedding daemon is absent (no fetch is made).
 */
async function loadRecalled(
  args: LoadRecalledArgs,
): Promise<readonly MemoryEntry[]> {
  if (args.k <= 0) return [];
  const query = args.query.trim();
  if (query.length === 0) return [];
  try {
    return await args.store.recallHybridAsync(query, {
      k: args.k,
      ...(args.workingDir !== undefined
        ? { scope: "project" as const, workingDir: args.workingDir }
        : {}),
    });
  } catch {
    return [];
  }
}

function buildRecallQuery(input: MemoryContextProviderInput): string {
  const parts: string[] = [];
  const userMessage = (input.userMessage ?? "").trim();
  if (userMessage.length > 0) parts.push(userMessage);
  for (const summary of input.toolResultSummaries ?? []) {
    const normalized = summary.trim();
    if (normalized.length > 0) parts.push(normalized);
  }
  return parts.join("\n");
}

interface ExpandArgs {
  store: MemoryStore;
  base: readonly MemoryEntry[];
  links: DefaultMemoryContextProviderOptions["links"];
  metrics: AgentMetrics | undefined;
}

/**
 * Memory-v2 phase 2. Walk `LinkStore` outward from the BM25/cosine
 * hits and hydrate the expanded ids into MemoryEntry rows. Returns
 * `[...base, ...expansion]` in stable order; duplicates filtered.
 *
 * Hydration uses `MemoryStore.get(id)` — entries that no longer
 * exist (e.g. evicted by phase 1A utility-weighted eviction) are
 * silently dropped, the graph row's `ON DELETE CASCADE` will clean
 * up the edge on the next memory removal.
 */
function expandWithLinks(args: ExpandArgs): readonly MemoryEntry[] {
  if (!args.links || !args.links.enabled || args.base.length === 0) {
    return args.base;
  }
  let expanded: number[];
  try {
    expanded = args.links.store.expand(
      args.base.map((e) => e.id),
      {
        depth: args.links.depth,
        maxExpanded: args.links.maxExpanded,
      },
    );
  } catch {
    return args.base;
  }
  if (expanded.length === 0) return args.base;
  const seen = new Set<number>(args.base.map((e) => e.id));
  const hydrated: MemoryEntry[] = [];
  for (const id of expanded) {
    if (seen.has(id)) continue;
    const entry = args.store.get(id);
    if (!entry) continue;
    hydrated.push(entry);
    seen.add(id);
  }
  if (hydrated.length === 0) return args.base;
  args.metrics?.recordMemoryLinkExpansion({
    expanded: hydrated.length,
    depth: args.links.depth,
  });
  return [...args.base, ...hydrated];
}

interface LoadIndexArgs {
  store: MemoryStore;
  limit: number;
  previewChars: number;
  workingDir: string | null | undefined;
  excludeIds: ReadonlySet<number>;
}

function loadIndex(args: LoadIndexArgs): readonly MemoryIndexEntry[] {
  if (args.limit <= 0) return [];
  try {
    // Overfetch a bit so that after dedup against recalled we still
    // have enough pointers to fill the configured `limit`.
    const overfetch = args.limit + args.excludeIds.size;
    const raw = args.store.listIndex({
      limit: overfetch,
      previewChars: args.previewChars,
      ...(args.workingDir !== undefined
        ? { scope: "project" as const, workingDir: args.workingDir }
        : {}),
    });
    const filtered = raw.filter((row) => !args.excludeIds.has(row.id));
    return filtered.slice(0, args.limit);
  } catch {
    return [];
  }
}
