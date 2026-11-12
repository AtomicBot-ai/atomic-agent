/**
 * Write the stored chats to a local chat fine-tuning JSONL file
 * (ATO-1104). Newest chats first, one line per chat (see
 * `build-dataset-record.ts`), every message scrubbed (see
 * `scrub-dataset-text.ts`). Reads the session store and writes one file;
 * nothing goes over the network.
 *
 * The file is created owner-only and never over an existing one, so a
 * second run cannot silently replace a file the person already checked.
 */

import { closeSync, openSync, unlinkSync, writeSync } from "node:fs";

import type { SessionStore } from "../session-store.js";
import { sessionSummaryCursorAfter } from "../session-summary-page.js";
import { buildDatasetRecord } from "./build-dataset-record.js";
import type { DatasetScrubber } from "./scrub-dataset-text.js";

export interface ExportDatasetOptions {
  store: Pick<SessionStore, "listSummaryPage" | "listChatLines">;
  outFile: string;
  scrubber: DatasetScrubber;
  /** Most chats to write; all of them when omitted. */
  maxSessions?: number;
  /** Only chats last active at or after this time (epoch ms). */
  sinceMs?: number;
  /** Rows read per page of the session list. */
  pageSize?: number;
}

export interface ExportDatasetResult {
  /** Chats written, one line each. */
  records: number;
  messages: number;
  /** Chats read, written or not. */
  sessionsRead: number;
  /** Chats read that had no question with an answer. */
  sessionsSkipped: number;
}

const DEFAULT_PAGE_SIZE = 200;

export function exportDataset(options: ExportDatasetOptions): ExportDatasetResult {
  const { store, scrubber } = options;
  const limit = Math.max(1, options.pageSize ?? DEFAULT_PAGE_SIZE);
  const max = options.maxSessions ?? Number.POSITIVE_INFINITY;
  const result: ExportDatasetResult = { records: 0, messages: 0, sessionsRead: 0, sessionsSkipped: 0 };

  // `wx`: refuse a file that is already there; 0o600: chats are private.
  const fd = openSync(options.outFile, "wx", 0o600);
  let ok = false;
  try {
    let after = sessionSummaryCursorAfter([]);
    walk: for (;;) {
      const page = store.listSummaryPage(after ? { limit, after } : { limit });
      for (const summary of page) {
        // The list is newest first: past `since`, every later row is older.
        if (options.sinceMs !== undefined && summary.updatedAt < options.sinceMs) break walk;
        if (result.records >= max) break walk;
        result.sessionsRead += 1;
        const record = buildDatasetRecord(store.listChatLines(summary.id), scrubber.scrub);
        if (!record) {
          result.sessionsSkipped += 1;
          continue;
        }
        writeSync(fd, `${JSON.stringify(record)}\n`);
        result.records += 1;
        result.messages += record.messages.length;
      }
      if (page.length < limit) break;
      after = sessionSummaryCursorAfter(page);
    }
    ok = true;
  } finally {
    closeSync(fd);
    // A half-written file is worse than none: it looks finished.
    if (!ok) {
      try {
        unlinkSync(options.outFile);
      } catch {
        // Already gone; the original error is the one worth reporting.
      }
    }
  }
  return result;
}
