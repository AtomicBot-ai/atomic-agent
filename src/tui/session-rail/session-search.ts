import type { SessionPickerEntry } from "../tui-state.js";

/**
 * History search in the session picker (ATO-1153, epic ATO-1013 item 5).
 *
 * With the picker open, what the operator types into the composer (after
 * any draft it already held, see {@link pickerQuery}) is the query: the list narrows to the sessions whose title or message text
 * holds it (case-insensitive substring), and a session found by its text
 * shows the matched words in place of its title.
 *
 * The search goes through one function, {@link SessionPickerSearch}.
 * {@link createIndexedSessionPickerSearch} adds the store's FTS5 index
 * (`SessionStore.searchTranscripts`, ATO-1149/1151, ATO-1510) so sessions
 * past the loaded pages are found too, without touching the picker, the
 * keys or the submit path.
 */
export type SessionPickerSearch = (
  entries: readonly SessionPickerEntry[],
  query: string,
) => readonly SessionPickerEntry[];

/**
 * The user messages and closing replies of one stored session —
 * `SessionStore.listChatLines`, which projects them in SQL so tool
 * output is never parsed.
 */
export type SessionTextSource = (sessionId: string) => readonly { text: string }[];

/** Text kept per session for matching; a longer transcript is searched in its first part. */
export const SEARCH_TEXT_MAX_CHARS = 200_000;
/** Sessions whose text is kept between keystrokes. */
export const SEARCH_CACHE_MAX_SESSIONS = 400;
/** Width of a matched snippet: the picker cuts its preview at 48, ellipses included. */
export const SEARCH_SNIPPET_CHARS = 46;

/**
 * The matcher over the loaded list: the title (`preview`) first, then
 * the session's text, read through `source` the first time a query
 * needs it and kept (capped, lowercased) until the session changes.
 * Without a source only titles are matched.
 *
 * The last answer is remembered by list identity and query, so the
 * render and the submit of the same frame scan once.
 */
export function createSessionPickerSearch(
  source?: SessionTextSource,
): SessionPickerSearch {
  const texts = new Map<string, { updatedAt: number; raw: string; lower: string }>();
  let last: {
    entries: readonly SessionPickerEntry[];
    query: string;
    result: readonly SessionPickerEntry[];
  } | null = null;

  const textOf = (entry: SessionPickerEntry) => {
    const hit = texts.get(entry.sessionId);
    if (hit && hit.updatedAt === entry.updatedAt) return hit;
    let raw = "";
    try {
      raw = joinCapped(source?.(entry.sessionId) ?? [], SEARCH_TEXT_MAX_CHARS);
    } catch {
      // A store that cannot answer leaves the title to match on.
    }
    const value = { updatedAt: entry.updatedAt, raw, lower: raw.toLowerCase() };
    texts.delete(entry.sessionId);
    texts.set(entry.sessionId, value);
    while (texts.size > SEARCH_CACHE_MAX_SESSIONS) {
      const oldest = texts.keys().next().value;
      if (oldest === undefined) break;
      texts.delete(oldest);
    }
    return value;
  };

  return (entries, query) => {
    const needle = normaliseQuery(query);
    if (needle.length === 0) return entries;
    if (last && last.entries === entries && last.query === needle) {
      return last.result;
    }
    const result: SessionPickerEntry[] = [];
    for (const entry of entries) {
      if (entry.preview.toLowerCase().includes(needle)) {
        result.push(entry);
        continue;
      }
      if (!source) continue;
      const text = textOf(entry);
      const at = text.lower.indexOf(needle);
      if (at < 0) continue;
      result.push({
        ...entry,
        preview: snippetAround(text.raw, at, needle.length, SEARCH_SNIPPET_CHARS),
      });
    }
    last = { entries, query: needle, result };
    return result;
  };
}

/**
 * One hit of the store's full-text index (`SessionStore.searchTranscripts`,
 * ATO-1149): the fields the picker needs to show a session that is not on
 * the loaded pages of the list.
 */
export interface IndexedSessionHit {
  sessionId: string;
  workingDir: string;
  updatedAt: number;
  /** The matching part of a line, terms wrapped in `«` and `»`. */
  snippet: string;
}

/** Ask the index; throws when the index cannot be created. */
export type IndexedSessionSource = (query: string) => readonly IndexedSessionHit[];

/** Hits asked of the index per query: the route's own maximum. */
export const INDEXED_SEARCH_LIMIT = 25;

/**
 * The picker's search over the whole history (ATO-1510): the matcher
 * above over the loaded list first, exactly as before, then the sessions
 * the FTS5 index finds that are not on the loaded pages, newest hit
 * first, each with its matched words as the preview. An index that
 * cannot answer (no FTS5, a read-only file) leaves the loaded-list
 * matcher alone, so the search never gets worse than it was.
 */
export function createIndexedSessionPickerSearch(
  index: IndexedSessionSource,
  source?: SessionTextSource,
): SessionPickerSearch {
  const local = createSessionPickerSearch(source);
  let last: {
    entries: readonly SessionPickerEntry[];
    query: string;
    result: readonly SessionPickerEntry[];
  } | null = null;

  return (entries, query) => {
    const needle = normaliseQuery(query);
    if (needle.length === 0) return entries;
    if (last && last.entries === entries && last.query === needle) {
      return last.result;
    }
    const matched = local(entries, query);
    let hits: readonly IndexedSessionHit[] = [];
    try {
      hits = index(needle);
    } catch {
      // The loaded-list answer stands.
    }
    const seen = new Set(entries.map((e) => e.sessionId));
    const extra: SessionPickerEntry[] = [];
    for (const hit of hits) {
      if (seen.has(hit.sessionId)) continue;
      seen.add(hit.sessionId);
      extra.push({
        sessionId: hit.sessionId,
        workingDir: hit.workingDir,
        // Not known from a hit; the picker reloads the session on switch.
        turnCount: 0,
        stepCount: 0,
        updatedAt: hit.updatedAt,
        preview: snippetFromHit(hit.snippet, SEARCH_SNIPPET_CHARS),
        pinned: false,
      });
    }
    const result = extra.length > 0 ? [...matched, ...extra] : matched;
    last = { entries, query: needle, result };
    return result;
  };
}

/** The index's snippet as one plain line for the picker, at most `width` characters. */
export function snippetFromHit(snippet: string, width: number): string {
  const plain = snippet.replace(/[«»]/g, "").replace(/\s+/g, " ").trim();
  if (plain.length <= width) return plain;
  return `${plain.slice(0, Math.max(1, width - 1))}…`;
}

/** One line, trimmed, lowercased: what the matcher compares. */
export function normaliseQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The words around a match, on one line, at most `width` characters,
 * with `…` where text was cut. Index arithmetic is on the raw text, so
 * whitespace is collapsed only after the window is chosen.
 */
export function snippetAround(
  text: string,
  at: number,
  length: number,
  width: number,
): string {
  const lead = Math.max(0, Math.floor((width - length) / 3));
  let start = Math.max(0, at - lead);
  const end = Math.min(text.length, start + Math.max(width, length));
  start = Math.max(0, Math.min(start, end - width));
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}

function joinCapped(lines: readonly { text: string }[], max: number): string {
  let out = "";
  for (const line of lines) {
    if (out.length >= max) break;
    out += (out.length > 0 ? "\n" : "") + line.text;
  }
  return out.length > max ? out.slice(0, max) : out;
}

/**
 * The picker's search: what was typed after the draft the composer held
 * when the picker opened. Text that no longer starts with that draft
 * (the operator edited into it) is searched whole.
 */
export function pickerQuery(state: {
  inputValue: string;
  sessionPickerDraft: string;
}): string {
  const { inputValue, sessionPickerDraft: draft } = state;
  return inputValue.startsWith(draft) ? inputValue.slice(draft.length) : inputValue;
}

/** Title-only matching, for a host that wires no text source. */
const titleOnlySearch = createSessionPickerSearch();

/**
 * The rows the open picker shows: the whole list, or the matches for
 * the composer's text. The picker, the ↓ key and Enter all read this,
 * so the cursor always indexes the same rows.
 */
export function visiblePickerSessions(
  state: {
    sessionPickerOpen: boolean;
    sessionPickerList: readonly SessionPickerEntry[];
    inputValue: string;
    sessionPickerDraft: string;
  },
  search: SessionPickerSearch | undefined,
): readonly SessionPickerEntry[] {
  if (!state.sessionPickerOpen) return state.sessionPickerList;
  return (search ?? titleOnlySearch)(state.sessionPickerList, pickerQuery(state));
}
