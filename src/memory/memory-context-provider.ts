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
import type {
  LessonIndexEntry,
  LessonStore,
} from "./lessons/lesson-store.js";
import type {
  ProcedureIndexEntry,
  ProcedureStore,
} from "./procedures/procedure-store.js";

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
  /**
   * Memory-v2 phase 5. Top-K lessons surfaced into `### lessons`.
   * When `store` is undefined or `enabled=false`, the provider
   * returns an empty array and the prompt renderer skips the
   * section entirely.
   *
   * Recall query is the same `buildRecallQuery` output used for
   * `### recalled` (userMessage + recent tool summaries) — we keep
   * the surfaces consistent so a thematic match against notes
   * usually matches against lessons too.
   */
  lessons?: {
    enabled: boolean;
    store: LessonStore;
    k: number;
  };
  /**
   * Memory-v2 phase 7b. Top-K procedures surfaced into
   * `### procedures`. Mirrors `lessons.*` — empty array when
   * `store` is undefined, `enabled=false`, or `k <= 0`. The
   * recall query is the same `buildRecallQuery` output so a
   * thematic hit against lessons usually surfaces the paired
   * procedure too (scenarios 7b.A → 7b.C).
   */
  procedures?: {
    enabled: boolean;
    store: ProcedureStore;
    k: number;
    /** Optional vote-aware reranking blend; sourced from `memory.voting.scoreBlend`. */
    scoreBlend?: number;
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
      // Memory-v2 phase 5/7b: include `lessons` / `procedures`
      // when their surfaces are configured. Callers that pre-date
      // the fields still see the byte-identical `{ recalled, index }`
      // shape; later consumers see additional arrays.
      const out: MemoryContext = { recalled, index };
      if (opts.lessons && opts.lessons.enabled) {
        out.lessons = loadLessons({
          lessons: opts.lessons,
          query: buildRecallQuery(input),
        });
      }
      if (opts.procedures && opts.procedures.enabled) {
        out.procedures = loadProcedures({
          procedures: opts.procedures,
          query: buildRecallQuery(input),
        });
      }
      return out;
    },
  };
}

interface LoadProceduresArgs {
  procedures: DefaultMemoryContextProviderOptions["procedures"];
  query: string;
}

/**
 * Memory-v2 phase 7b. Pre-fetch `### procedures` pointer rows.
 *
 * Mirrors `loadLessons`. The recall is fire-safe — any failure
 * inside `ProcedureStore.recall` is swallowed so a corrupt FTS
 * index never blocks the agent loop. When `scoreBlend` is set we
 * widen the BM25 pool and re-sort by `combinedScore`, which lets
 * a strongly downvoted procedure drop out of the top-K even when
 * its keyword overlap would otherwise have surfaced it
 * (scenario 7b.E.3).
 */
function loadProcedures(args: LoadProceduresArgs): readonly ProcedureIndexEntry[] {
  const cfg = args.procedures;
  if (!cfg || !cfg.enabled || cfg.k <= 0) return [];
  const query = args.query.trim();
  if (query.length === 0) return [];
  try {
    const recallOpts: { query: string; k: number; scoreBlend?: number } = {
      query,
      k: cfg.k,
    };
    if (typeof cfg.scoreBlend === "number") {
      recallOpts.scoreBlend = cfg.scoreBlend;
    }
    const hits = cfg.store.recall(recallOpts);
    return hits.map((p) => ({
      id: p.id,
      activation: p.activation,
      tags: p.tags,
      workingDir: p.workingDir,
      updatedAt: p.updatedAt,
    }));
  } catch {
    return [];
  }
}

interface LoadLessonsArgs {
  lessons: DefaultMemoryContextProviderOptions["lessons"];
  query: string;
}

/**
 * Memory-v2 phase 5. Pre-fetch `### lessons` pointer rows.
 *
 * Cross-phase invariant 8: this is computed per-turn and stored
 * ephemerally on `SessionState.recalledLessons`. The BM25 path is
 * synchronous + fire-safe — any failure inside `LessonStore.recall`
 * is swallowed so a corrupt FTS index never blocks the agent loop.
 *
 * The recall returns full `Lesson` rows; we project down to
 * `LessonIndexEntry` so the renderer can stay byte-stable with the
 * "no full body in the prompt" contract.
 */
function loadLessons(args: LoadLessonsArgs): readonly LessonIndexEntry[] {
  const cfg = args.lessons;
  if (!cfg || !cfg.enabled || cfg.k <= 0) return [];
  const query = args.query.trim();
  if (query.length === 0) return [];
  try {
    const hits = cfg.store.recall({ query, k: cfg.k });
    return hits.map((l) => ({
      id: l.id,
      activation: l.activation,
      tags: l.tags,
      workingDir: l.workingDir,
      updatedAt: l.updatedAt,
    }));
  } catch {
    return [];
  }
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
      // Memory-v2 phase 5. Archived parents (`consolidated_into IS
      // NOT NULL`) must drop out of the hot index — their content
      // is now distilled into a lesson. They remain readable by id
      // via `memory.notes.recall { id }` (cross-phase invariant 9).
      excludeArchived: true,
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
