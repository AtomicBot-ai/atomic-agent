import { useCallback, useEffect, useMemo, useState } from "react";
import { activeMention, completeMention } from "./mention-query.js";
import { rankMentionFiles } from "./rank-mention-files.js";

export interface FileMentionsOptions {
  /** The composer buffer. */
  buffer: string;
  /** Off while another surface owns the composer's keys. */
  enabled: boolean;
  /** The file list; absent turns the palette off entirely. */
  listFiles?: (() => Promise<readonly string[]>) | undefined;
}

export interface FileMentions {
  open: boolean;
  /** `null` until the first listing has arrived. */
  results: readonly string[] | null;
  cursor: number;
  move(delta: number): void;
  /** Put the cursor on `row` (a click). */
  select(row: number): void;
  /** The buffer with the highlighted path completed, or `null`. */
  accept(): string | null;
  /** Close until the buffer changes. */
  dismiss(): void;
}

/**
 * Composer-local state of the `@` palette. It lives in a hook, not the
 * app reducer: nothing outside the composer reads it, and the buffer it
 * derives from is already reducer state.
 */
export function useFileMentions(options: FileMentionsOptions): FileMentions {
  const { buffer, enabled, listFiles } = options;
  const mention = enabled && listFiles ? activeMention(buffer) : null;
  const [files, setFiles] = useState<readonly string[] | null>(null);
  const [cursor, setCursor] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);
  const active = mention !== null;
  const query = mention?.query ?? "";

  // Each time a mention starts, ask for the list: the index answers from
  // its cache and refreshes behind it, so this is cheap after the first.
  useEffect(() => {
    if (!active || !listFiles) return;
    let live = true;
    listFiles().then(
      (list) => { if (live) setFiles(list); },
      () => { if (live) setFiles([]); },
    );
    return () => { live = false; };
  }, [active, listFiles]);

  useEffect(() => setCursor(0), [query]);
  useEffect(() => {
    if (dismissedAt !== null && dismissedAt !== buffer) setDismissedAt(null);
  }, [buffer, dismissedAt]);

  const results = useMemo(
    () => (files === null ? null : rankMentionFiles(query, files)),
    [files, query],
  );
  const open = active && dismissedAt !== buffer;
  const count = results?.length ?? 0;
  const safeCursor = Math.max(0, Math.min(cursor, count - 1));

  const move = useCallback(
    (delta: number) => {
      if (count === 0) return;
      setCursor((c) => (Math.max(0, Math.min(c, count - 1)) + delta + count) % count);
    },
    [count],
  );
  const select = useCallback(
    (row: number) => setCursor(Math.max(0, Math.min(row, count - 1))),
    [count],
  );
  const accept = useCallback((): string | null => {
    const chosen = results?.[safeCursor];
    if (!mention || chosen === undefined) return null;
    return completeMention(buffer, mention, chosen);
  }, [results, safeCursor, mention, buffer]);
  const dismiss = useCallback(() => setDismissedAt(buffer), [buffer]);

  return { open, results, cursor: safeCursor, move, select, accept, dismiss };
}
