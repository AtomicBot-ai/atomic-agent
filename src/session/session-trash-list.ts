import { ARCHIVED_TURNS_KEY } from "./turn-archive.js";
import {
  SESSION_TRASHED_METADATA_KEY,
  SESSION_TRASHED_SET_AT_KEY,
} from "./session-trashed.js";

/**
 * ATO-2474: the chats in Trash (`metadata.trashed: true`,
 * `session-trashed.ts`), newest move first. What the terminal's
 * `/sessions --deleted` lists and restores from; every other list
 * (`listSummaryPage`) leaves them out, as it does incognito chats.
 *
 * Projected in SQL like a summary page, so no transcript is parsed. The
 * filter cannot use an index (the flag lives in the JSON), so this walks
 * the table: it runs only when someone asks for Trash, never on boot or
 * after a turn, which is why it is a separate read and not a mode of the
 * summary page.
 */
export const TRASHED_LIST_SQL = `
SELECT id,
       working_dir AS workingDir,
       updated_at AS updatedAt,
       json_extract(payload, '$.metadata.title') AS title,
       COALESCE(
         json_extract(payload, '$.${ARCHIVED_TURNS_KEY}.firstUserText'),
         (SELECT json_extract(t.value, '$.text')
            FROM json_each(payload, '$.turns') AS t
           WHERE t.type = 'object'
             AND json_extract(t.value, '$.kind') = 'user'
           LIMIT 1)) AS firstPrompt,
       json_extract(payload, '$.metadata.${SESSION_TRASHED_SET_AT_KEY}') AS trashedAt
  FROM sessions
 WHERE json_valid(payload) AND json_type(payload, '$.turns') = 'array'
   AND json_type(payload, '$.metadata.${SESSION_TRASHED_METADATA_KEY}') = 'true'
 ORDER BY COALESCE(json_extract(payload, '$.metadata.${SESSION_TRASHED_SET_AT_KEY}'), updated_at) DESC, id DESC
 LIMIT :limit`;

/** One chat in Trash, as a list shows it. */
export interface TrashedSessionSummary {
  id: string;
  workingDir: string;
  updatedAt: number;
  /** The generated or typed name, `null` when it has none. */
  title: string | null;
  /** The first message, which names a chat that has no title. */
  firstPrompt: string | null;
  /** When it went to Trash (epoch ms), `null` for a flag with no stamp. */
  trashedAt: number | null;
}

export interface TrashedRow {
  id: string;
  workingDir: string;
  updatedAt: number;
  title: unknown;
  firstPrompt: unknown;
  trashedAt: unknown;
}

export function toTrashedSummary(row: TrashedRow): TrashedSessionSummary {
  return {
    id: row.id,
    workingDir: row.workingDir,
    updatedAt: row.updatedAt,
    title: typeof row.title === "string" && row.title ? row.title : null,
    firstPrompt: typeof row.firstPrompt === "string" ? row.firstPrompt : null,
    trashedAt:
      typeof row.trashedAt === "number" && Number.isFinite(row.trashedAt)
        ? row.trashedAt
        : null,
  };
}

/** Rows at most for one read of Trash. */
export const TRASHED_LIST_MAX = 200;
