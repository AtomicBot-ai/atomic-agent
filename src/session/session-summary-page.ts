import type { SessionSummary } from "./session-summary.js";

/**
 * One page of list rows, newest first, with the fields a list renders
 * lifted out of the JSON in SQL.
 *
 * No `JSON.parse`, because one malformed payload must not take every
 * other row down with it. The `WHERE` keeps the `json_each` subquery
 * off payloads it cannot walk, and each subquery's `t.type = 'object'`
 * keeps `json_extract` off array elements that are not JSON objects —
 * a bare string element is not JSON text and would raise "malformed
 * JSON". `AND` short-circuits, so the guards hold as long as they come
 * first, which is why nothing is ever inserted before them.
 *
 * `EXISTS` is the third guard and the one that makes a page bounded
 * *and* useful: every `+ new` and every scheduled task persists an
 * unnamed session, and a window that carried those would hand back a
 * page of rows the rail then hides — the real conversations pushed out
 * by rows nobody can tell apart. Filtering them here means one page of
 * `limit` rows is one page of `limit` threads someone has spoken to.
 *
 * The order is `updated_at DESC, id DESC` and the cursor compares on
 * both, because `updated_at` is not unique: an import writes a batch of
 * rows in one millisecond, and a cursor that knew only the timestamp
 * would either skip the rest of the tie or hand it back twice. The
 * order matches `idx_sessions_updated_id` exactly, so SQLite walks the
 * index rather than sorting the table, and reads the cursor as a range
 * seek on it (`SEARCH sessions USING INDEX idx_sessions_updated_id`) —
 * page 40 costs what page 1 costs.
 */
function summaryPageSql(cursored: boolean): string {
  return `
SELECT id,
       working_dir AS workingDir,
       status,
       created_at AS createdAt,
       updated_at AS updatedAt,
       json_extract(payload, '$.turnCount') AS turnCount,
       json_extract(payload, '$.stepCount') AS stepCount,
       (SELECT json_extract(t.value, '$.text')
          FROM json_each(payload, '$.turns') AS t
         WHERE t.type = 'object'
           AND json_extract(t.value, '$.kind') = 'user'
         LIMIT 1) AS firstPrompt,
       json_extract(payload, '$.metadata.title') AS title,
       json_extract(payload, '$.metadata.importedFrom') AS importedFrom
  FROM sessions
 WHERE json_valid(payload) AND json_type(payload, '$.turns') = 'array'
   AND EXISTS (SELECT 1
                 FROM json_each(payload, '$.turns') AS t
                WHERE t.type = 'object'
                  AND json_extract(t.value, '$.kind') = 'user')${
                    cursored
                      ? `
   AND (updated_at < :afterUpdatedAt
        OR (updated_at = :afterUpdatedAt AND id < :afterId))`
                      : ""
                  }
 ORDER BY updated_at DESC, id DESC
 LIMIT :limit`;
}

/** The first page: no cursor, so the walk starts at the newest row. */
export const SUMMARY_FIRST_PAGE_SQL = summaryPageSql(false);

/** Every page after the first, resumed from the row the last one ended on. */
export const SUMMARY_NEXT_PAGE_SQL = summaryPageSql(true);

/**
 * Where a page ended: the sort key of its last row, which is what the
 * next page resumes from. Both fields are needed — see the tie note on
 * the SQL above.
 */
export interface SessionSummaryCursor {
  updatedAt: number;
  id: string;
}

/** What `listSummaryPage` asks for: a bound, and where to resume. */
export interface SessionSummaryPageOptions {
  /** Rows at most. Never negative — SQLite reads `LIMIT -1` as no limit. */
  limit: number;
  /** Omitted for the first page. */
  after?: SessionSummaryCursor;
}

/** The row shape the projection above hands back, before coercion. */
export interface SummaryRow {
  id: string;
  workingDir: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  turnCount: unknown;
  stepCount: unknown;
  firstPrompt: unknown;
  title: unknown;
  importedFrom: unknown;
}

export function toSummary(row: SummaryRow): SessionSummary {
  return {
    id: row.id,
    workingDir: row.workingDir,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    turnCount: toCount(row.turnCount),
    stepCount: toCount(row.stepCount),
    firstPrompt: toText(row.firstPrompt),
    title: toText(row.title),
    importedFrom: toText(row.importedFrom),
  };
}

/** `json_extract` hands back whatever the JSON held; a count is a number or 0. */
function toCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** `NULL` stays null; a non-string JSON value is still shown, as text. */
function toText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : String(value);
}

/** Bind parameters for one page, cursor included when there is one. */
export function summaryPageParams(
  options: SessionSummaryPageOptions,
): Record<string, number | string> {
  const limit = Math.max(0, Math.trunc(options.limit));
  if (!options.after) return { limit };
  return {
    limit,
    afterUpdatedAt: options.after.updatedAt,
    afterId: options.after.id,
  };
}

/** The cursor that resumes after `rows`, or `null` for an empty page. */
export function sessionSummaryCursorAfter(
  rows: readonly SessionSummary[],
): SessionSummaryCursor | null {
  const last = rows.at(-1);
  return last ? { updatedAt: last.updatedAt, id: last.id } : null;
}
