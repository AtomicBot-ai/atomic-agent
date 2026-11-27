import type { SessionPickerEntry } from "../tui-state.js";
import {
  createIndexedSessionPickerSearch,
  joinCapped,
  normaliseQuery,
  SEARCH_CACHE_MAX_SESSIONS,
  SEARCH_TEXT_MAX_CHARS,
  type IndexedSessionHit,
  type SessionPickerSearch,
  type SessionTextSource,
} from "./session-search.js";

/**
 * The picker's search index, built once per list and off the keystroke
 * (ATO-1659).
 *
 * Before, every query paid for the index on the TUI thread: the store's
 * `searchTranscripts` synced the FTS5 index first (the first sync reads
 * and writes up to 500 chats, and every later one still takes the write
 * lock and scans `sessions` for changed rows), and the loaded-list
 * matcher read a session's text the first time a query needed it.
 *
 * Now the first query on a list starts a build in the background, a few
 * sessions per tick (`setImmediate`, so keys and renders run between
 * ticks): the FTS5 sync in rounds of 25, then the text of each loaded
 * session. Queries reuse it: a keystroke is an FTS5 read and a scan of
 * text already in memory. A new list (the picker reopened, a chat made,
 * deleted, renamed or touched, another page loaded) is a new build,
 * which keeps the texts of the sessions whose `updatedAt` did not move
 * and syncs only the changed rows. While a build runs the search answers
 * nothing and {@link SessionPickerSearchIndex.building} says so, so the
 * picker shows its loading line instead of a partial list.
 *
 * The answers are the ones {@link createIndexedSessionPickerSearch} gives
 * over the same index: the matching code is that function, fed from the
 * build.
 */

/** The store's FTS5 index, split so its sync can be spread over ticks. */
export interface PickerIndexSource {
  /** Sync at most `budget` changed sessions; how many are left. Throws when there is no index. */
  sync(budget: number): number;
  /** Hits from what is indexed now, no sync. Throws when there is no index. */
  match(query: string): readonly IndexedSessionHit[];
}

/** Runs `task` later, after pending input and renders. */
export type PickerIndexScheduler = (task: () => void) => void;

/** Sessions synced per tick: the store's own per-transaction round. */
export const SYNC_SESSIONS_PER_TICK = 25;
/** Sync ticks per build: 500 sessions, the budget one search used to have. */
export const SYNC_MAX_TICKS = 20;
/** Transcripts read from the store per tick. */
export const TEXT_READS_PER_TICK = 8;

/** What the picker reads besides the search itself. */
export interface SessionSearchStatus {
  /** A query on `entries` would wait for a build: show the loading line. */
  building(entries: readonly SessionPickerEntry[], query: string): boolean;
  /** Called when a build finishes, so the view asks again. */
  subscribe(listener: () => void): () => void;
  /** Changes when a build finishes; for `useSyncExternalStore`. */
  version(): number;
}

export interface SessionPickerSearchIndex extends SessionSearchStatus {
  search: SessionPickerSearch;
}

interface StoredText {
  updatedAt: number;
  raw: string;
}

interface Build {
  entries: readonly SessionPickerEntry[];
  texts: Map<string, StoredText>;
  ready: boolean;
}

export function createSessionPickerSearchIndex(options: {
  index: PickerIndexSource;
  source?: SessionTextSource;
  schedule?: PickerIndexScheduler;
}): SessionPickerSearchIndex {
  const { index, source } = options;
  const schedule: PickerIndexScheduler =
    options.schedule ??
    ((task) => {
      setImmediate(task);
    });
  const listeners = new Set<() => void>();
  let current: Build | null = null;
  let builds = 0;
  /** FTS5 answers of the current build, per normalised query; `null` when it threw. */
  let hits = new Map<string, readonly IndexedSessionHit[] | null>();

  const textFor = (sessionId: string): readonly { text: string }[] => {
    const kept = current?.texts.get(sessionId);
    if (kept) return [{ text: kept.raw }];
    // Past the cap: read on demand, as the matcher always did.
    return source?.(sessionId) ?? [];
  };

  const matcher = createIndexedSessionPickerSearch((needle) => {
    if (!hits.has(needle)) {
      try {
        hits.set(needle, index.match(needle));
      } catch {
        hits.set(needle, null);
      }
    }
    const answer = hits.get(needle);
    if (answer === null || answer === undefined) {
      // The loaded-list answer stands, as when the index cannot answer.
      throw new Error("session index unavailable");
    }
    return answer;
  }, source ? textFor : undefined);

  const start = (entries: readonly SessionPickerEntry[]): void => {
    if (current?.entries === entries) return;
    const previous = current?.texts ?? new Map<string, StoredText>();
    const build: Build = { entries, texts: new Map(), ready: false };
    current = build;
    hits = new Map();
    const pending = source ? entries.slice(0, SEARCH_CACHE_MAX_SESSIONS) : [];
    let syncTicks = 0;
    let syncDone = false;
    let next = 0;

    const tick = (): void => {
      if (current !== build) return; // A newer list took over.
      if (!syncDone) {
        try {
          syncTicks += 1;
          const left = index.sync(SYNC_SESSIONS_PER_TICK);
          syncDone = left === 0 || syncTicks >= SYNC_MAX_TICKS;
        } catch {
          // No index, a busy lock or a closed store: search what is indexed.
          syncDone = true;
        }
        schedule(tick);
        return;
      }
      let reads = 0;
      while (next < pending.length && reads < TEXT_READS_PER_TICK) {
        const entry = pending[next++];
        if (entry === undefined) break;
        const kept = previous.get(entry.sessionId);
        if (kept && kept.updatedAt === entry.updatedAt) {
          build.texts.set(entry.sessionId, kept);
          continue;
        }
        reads += 1;
        let raw = "";
        try {
          raw = joinCapped(source?.(entry.sessionId) ?? [], SEARCH_TEXT_MAX_CHARS);
        } catch {
          // A store that cannot answer leaves the title to match on.
        }
        build.texts.set(entry.sessionId, { updatedAt: entry.updatedAt, raw });
      }
      if (next < pending.length) {
        schedule(tick);
        return;
      }
      build.ready = true;
      builds += 1;
      for (const listener of [...listeners]) listener();
    };
    schedule(tick);
  };

  const building = (entries: readonly SessionPickerEntry[], query: string): boolean => {
    if (normaliseQuery(query).length === 0) return false;
    return !(current?.entries === entries && current.ready);
  };

  return {
    search: (entries, query) => {
      if (normaliseQuery(query).length === 0) return entries;
      start(entries);
      if (!current?.ready) return [];
      return matcher(entries, query);
    },
    building,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    version: () => builds,
  };
}
