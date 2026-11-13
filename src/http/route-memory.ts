import {
  MEMORY_LIST_MAX_LIMIT,
  MemoryValidationError,
  type MemoryEntry,
} from "../memory/memory-store.js";
import {
  ProfileValidationError,
  type ProfileFact,
} from "../memory/profile-store.js";
import { isNameProfileKey } from "../memory/profile-name-keys.js";
import { openaiError } from "./openai-errors.js";
import {
  readJsonBody,
  sendError,
  sendJson,
  type HttpHandler,
} from "./request-context.js";

/**
 * The person's own edits to what the agent remembers (ATO-1124): list,
 * edit and delete notes and profile facts over HTTP, so the desktop's
 * Memory tab writes through the one process that owns memory.sqlite
 * instead of with its own SQL (the FTS index and the vectors would drift
 * apart). The writes call the same store methods as the agent's
 * `memory.notes.forget` / `memory.profile.remove` tools.
 *
 * Answers:
 *   GET    /api/memory/notes               → { notes: NoteJson[] }
 *   PATCH  /api/memory/notes/{id}  {text}  → { note: NoteJson }
 *   DELETE /api/memory/notes/{id}          → { removed: true, id }
 *   GET    /api/memory/profile             → { facts: FactJson[] }
 *   PATCH  /api/memory/profile/{key} {value} → { fact: FactJson }
 *   DELETE /api/memory/profile/{key}       → { removed: true, key }
 *   GET    /api/memory/profile/{key}/history → { key, versions: FactJson[] }
 * `400` for a bad id or body, `404` for an unknown id or key. Edits
 * and deletions made here are journaled as the person's (ATO-1059) and
 * can be undone through route-memory-history.ts.
 */

type NoteJson = MemoryEntry;

export interface FactJson {
  id: number;
  key: string;
  value: string;
  pinned: boolean;
  keywords: string[];
  validFrom: number;
  updatedAt: number;
  supersedes: number | null;
  supersededBy: number | null;
}

export function factJson(fact: ProfileFact): FactJson {
  return {
    id: fact.id,
    key: fact.key,
    value: fact.value,
    pinned: fact.pinned,
    keywords: fact.keywords,
    validFrom: fact.validFrom,
    updatedAt: fact.updatedAt,
    supersedes: fact.supersedes,
    supersededBy: fact.supersededBy,
  };
}

/** A positive integer note id from the path, or `null`. */
function parseNoteId(raw: string | undefined): number | null {
  if (!raw || !/^[1-9]\d{0,15}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

async function readObjectBody(
  req: Parameters<HttpHandler>[0],
): Promise<Record<string, unknown> | string> {
  let body: unknown;
  try {
    body = await readJsonBody<unknown>(req);
  } catch (err) {
    return err instanceof Error ? err.message : "invalid body";
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return "body must be a JSON object";
  }
  return body as Record<string, unknown>;
}

function validationMessage(err: unknown): string | null {
  if (err instanceof MemoryValidationError || err instanceof ProfileValidationError) {
    return `${err.field}: ${err.message}`;
  }
  return null;
}

/**
 * `GET /api/memory/notes?limit=<1..200>&includeArchived=1` — notes,
 * newest first. Notes folded into a consolidated one are left out unless
 * `includeArchived=1`.
 */
export function createListMemoryNotesHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const params = new URL(req.url ?? "/", "http://localhost").searchParams;
    const rawLimit = params.get("limit");
    const limit = rawLimit === null ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MEMORY_LIST_MAX_LIMIT) {
      sendError(res, 400, openaiError(`limit must be an integer 1..${MEMORY_LIST_MAX_LIMIT}`));
      return;
    }
    const notes: NoteJson[] = ctx.runtime.notesStore.list({
      limit,
      excludeArchived: params.get("includeArchived") !== "1",
    });
    sendJson(res, 200, { notes });
  };
}

/** `PATCH /api/memory/notes/{id}` `{ text }` — replace a note's text. */
export function createEditMemoryNoteHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const id = parseNoteId(ctx.params.id);
    if (id === null) {
      sendError(res, 400, openaiError("note id must be a positive integer"));
      return;
    }
    const body = await readObjectBody(req);
    if (typeof body === "string") {
      sendError(res, 400, openaiError(body));
      return;
    }
    if (typeof body.text !== "string") {
      sendError(res, 400, openaiError("text must be a string"));
      return;
    }
    let note: NoteJson | null;
    try {
      note = ctx.runtime.notesStore.updateContent(id, body.text, undefined, "user");
    } catch (err) {
      const message = validationMessage(err);
      if (message === null) throw err;
      sendError(res, 400, openaiError(message));
      return;
    }
    if (note === null) {
      sendError(res, 404, openaiError(`note not found: ${id}`));
      return;
    }
    sendJson(res, 200, { note });
  };
}

/** `DELETE /api/memory/notes/{id}` — what `memory.notes.forget` does. */
export function createDeleteMemoryNoteHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const id = parseNoteId(ctx.params.id);
    if (id === null) {
      sendError(res, 400, openaiError("note id must be a positive integer"));
      return;
    }
    if (!ctx.runtime.notesStore.remove(id, "user")) {
      sendError(res, 404, openaiError(`note not found: ${id}`));
      return;
    }
    sendJson(res, 200, { removed: true, id });
  };
}

/** `GET /api/memory/profile` — the active facts, sorted by key. */
export function createListProfileFactsHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    sendJson(res, 200, { facts: ctx.runtime.profileStore.list().map(factJson) });
  };
}

/**
 * `PATCH /api/memory/profile/{key}` `{ value }` — a new version of an
 * existing fact; the old one stays in its history. Pinned and keywords
 * are kept. A name the person typed here is their own words, so it is
 * stored as grounded (ATO-199) and shows in the prompt straight away.
 */
export function createEditProfileFactHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const key = ctx.params.key;
    if (!key) {
      sendError(res, 400, openaiError("profile key is required"));
      return;
    }
    const body = await readObjectBody(req);
    if (typeof body === "string") {
      sendError(res, 400, openaiError(body));
      return;
    }
    if (typeof body.value !== "string") {
      sendError(res, 400, openaiError("value must be a string"));
      return;
    }
    const store = ctx.runtime.profileStore;
    try {
      const current = store.get(key);
      if (current === null) {
        sendError(res, 404, openaiError(`profile fact not found: ${key}`));
        return;
      }
      const fact = store.set(current.key, body.value, {
        pinned: current.pinned,
        keywords: current.keywords,
        ...(isNameProfileKey(current.key) ? { nameGrounding: "grounded" as const } : {}),
      });
      sendJson(res, 200, { fact: factJson(fact) });
    } catch (err) {
      const message = validationMessage(err);
      if (message === null) throw err;
      sendError(res, 400, openaiError(message));
    }
  };
}

/** `DELETE /api/memory/profile/{key}` — what `memory.profile.remove` does. */
export function createDeleteProfileFactHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const key = ctx.params.key;
    if (!key) {
      sendError(res, 400, openaiError("profile key is required"));
      return;
    }
    let removed: boolean;
    try {
      removed = ctx.runtime.profileStore.remove(key, "user");
    } catch (err) {
      const message = validationMessage(err);
      if (message === null) throw err;
      sendError(res, 400, openaiError(message));
      return;
    }
    if (!removed) {
      sendError(res, 404, openaiError(`profile fact not found: ${key}`));
      return;
    }
    sendJson(res, 200, { removed: true, key });
  };
}

/**
 * `GET /api/memory/profile/{key}/history` — every version of a fact,
 * oldest first, the active one last (`supersededBy: null`). Empty for an
 * unknown key.
 */
export function createProfileFactHistoryHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const key = ctx.params.key;
    if (!key) {
      sendError(res, 400, openaiError("profile key is required"));
      return;
    }
    try {
      const versions = ctx.runtime.profileStore.history(key).map(factJson);
      sendJson(res, 200, { key, versions });
    } catch (err) {
      const message = validationMessage(err);
      if (message === null) throw err;
      sendError(res, 400, openaiError(message));
    }
  };
}
