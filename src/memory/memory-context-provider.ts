import type {
  MemoryContext,
  MemoryContextProvider,
  MemoryContextProviderInput,
} from "../agent/agent-loop.js";
import type {
  MemoryEntry,
  MemoryIndexEntry,
  MemoryStore,
} from "./memory-store.js";

/**
 * Configuration for the default memory context provider.
 *
 * `recall.k` / `recall.enabled` drive the `### recalled` section
 * (top-K BM25 notes against the current user message).
 * `index.limit` / `index.enabled` drive the `### memory-index` section
 * (compact pointer rows). Both are passed through to the renderer via
 * the agent loop's ephemeral session fields.
 *
 * The provider deduplicates: any id present in `recalled` is filtered
 * out of `index`, so the two sections never repeat the same note.
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
 *  - Deterministic ordering: BM25 rank for recalled, `updated_at DESC`
 *    for index, deduplication by id.
 */
export function createDefaultMemoryContextProvider(
  opts: DefaultMemoryContextProviderOptions,
): MemoryContextProvider {
  return {
    buildMemoryContext(
      input: MemoryContextProviderInput,
    ): MemoryContext {
      const recalled = opts.recall.enabled
        ? loadRecalled({
            store: opts.store,
            k: opts.recall.k,
            userMessage: input.userMessage,
            workingDir: opts.workingDir,
          })
        : [];
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
  userMessage: string | null;
  workingDir: string | null | undefined;
}

function loadRecalled(args: LoadRecalledArgs): readonly MemoryEntry[] {
  if (args.k <= 0) return [];
  const query = (args.userMessage ?? "").trim();
  if (query.length === 0) return [];
  try {
    return args.store.recall(query, {
      k: args.k,
      ...(args.workingDir !== undefined
        ? { scope: "project" as const, workingDir: args.workingDir }
        : {}),
    });
  } catch {
    return [];
  }
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
