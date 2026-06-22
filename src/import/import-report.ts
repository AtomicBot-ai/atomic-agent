/**
 * Source-agnostic import reporting. Every import source (hermes, and any
 * future one) produces `ImportItemResult`s aggregated into an
 * `ImportReport`. The `kind` is left generic so each source can narrow it
 * to its own option-id union while sharing the report machinery.
 */
export type ImportItemStatus = "migrated" | "skipped" | "conflict" | "error";

export interface ImportItemResult<Kind extends string = string> {
  /** Which option/domain produced this item (source-specific union). */
  kind: Kind;
  /** Source identifier (e.g. originating session id, cron id, env key). */
  source?: string;
  /** Destination identifier (e.g. created session/task id, env key). */
  destination?: string;
  status: ImportItemStatus;
  /** Human-readable explanation (skip cause, conflict detail, error text). */
  reason?: string;
}

export interface ImportReport<Kind extends string = string> {
  /** Count of items per status. */
  summary: Record<ImportItemStatus, number>;
  items: ImportItemResult<Kind>[];
  /** Whether the import actually wrote (false in preview / dry-run). */
  executed: boolean;
}

/** Build an empty summary counter. */
export function emptySummary(): Record<ImportItemStatus, number> {
  return { migrated: 0, skipped: 0, conflict: 0, error: 0 };
}

/** Aggregate item results into an `ImportReport`. */
export function buildReport<Kind extends string>(
  items: ImportItemResult<Kind>[],
  executed: boolean,
): ImportReport<Kind> {
  const summary = emptySummary();
  for (const item of items) {
    summary[item.status] += 1;
  }
  return { summary, items, executed };
}
