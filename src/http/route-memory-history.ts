import {
  MEMORY_CHANGE_LOG_LIST_MAX,
  restoreMemoryChange,
  restoreProfileVersion,
  type RestoreOutcome,
} from "../memory/evolution/index.js";
import { ProfileValidationError } from "../memory/profile-store.js";
import { MemoryValidationError } from "../memory/memory-store.js";
import { openaiError } from "./openai-errors.js";
import { factJson } from "./route-memory.js";
import {
  readJsonBody,
  sendError,
  sendJson,
  type HttpHandler,
} from "./request-context.js";

/**
 * Memory history and undo (ATO-1059), next to the edit routes of
 * route-memory.ts:
 *
 *   GET  /api/memory/changes?limit=1..200&kind=note|profile
 *        → { changes: MemoryChange[] }, newest first
 *   POST /api/memory/changes/{id}/restore
 *        → { restored: true, change, note? , fact? }
 *        404 change_not_found; 409 already_restored | note_gone
 *   POST /api/memory/profile/{key}/restore { versionId }
 *        → { fact }   (a version id from GET .../history; 404 version_not_found)
 *
 * The journal holds note edits, note deletions and profile deletions,
 * by the person or the agent, for 90 days. Profile edits are versions
 * already (`GET /api/memory/profile/{key}/history`).
 */

function badRequest(err: unknown): string | null {
  if (err instanceof MemoryValidationError || err instanceof ProfileValidationError) {
    return `${err.field}: ${err.message}`;
  }
  return null;
}

export function createListMemoryChangesHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const params = new URL(req.url ?? "/", "http://localhost").searchParams;
    const rawLimit = params.get("limit");
    const limit = rawLimit === null ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MEMORY_CHANGE_LOG_LIST_MAX) {
      sendError(res, 400, openaiError(`limit must be an integer 1..${MEMORY_CHANGE_LOG_LIST_MAX}`));
      return;
    }
    const kind = params.get("kind");
    if (kind !== null && kind !== "note" && kind !== "profile") {
      sendError(res, 400, openaiError("kind must be note or profile"));
      return;
    }
    const changes = ctx.runtime.notesStore
      .getChangeLog()
      .list({ limit, ...(kind !== null ? { kind } : {}) });
    sendJson(res, 200, { changes });
  };
}

export function createRestoreMemoryChangeHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const raw = ctx.params.id;
    if (!raw || !/^[1-9]\d{0,15}$/.test(raw)) {
      sendError(res, 400, openaiError("change id must be a positive integer"));
      return;
    }
    let outcome: RestoreOutcome;
    try {
      outcome = restoreMemoryChange(Number(raw), {
        notes: ctx.runtime.notesStore,
        profile: ctx.runtime.profileStore,
      });
    } catch (err) {
      const message = badRequest(err);
      if (message === null) throw err;
      sendError(res, 400, openaiError(message));
      return;
    }
    if (!outcome.ok) {
      sendError(res, outcome.status, openaiError(outcome.message, "invalid_request_error", null, outcome.code));
      return;
    }
    sendJson(res, 200, {
      restored: true,
      change: outcome.change,
      ...(outcome.note ? { note: outcome.note } : {}),
      ...(outcome.fact ? { fact: factJson(outcome.fact) } : {}),
    });
  };
}

export function createRestoreProfileVersionHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const key = ctx.params.key;
    if (!key) {
      sendError(res, 400, openaiError("profile key is required"));
      return;
    }
    let body: unknown;
    try {
      body = await readJsonBody<unknown>(req);
    } catch (err) {
      sendError(res, 400, openaiError(err instanceof Error ? err.message : "invalid body"));
      return;
    }
    const versionId =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>).versionId
        : undefined;
    if (typeof versionId !== "number" || !Number.isInteger(versionId) || versionId <= 0) {
      sendError(res, 400, openaiError("versionId must be a positive integer"));
      return;
    }
    try {
      const outcome = restoreProfileVersion(ctx.runtime.profileStore, key, versionId);
      if (!outcome.ok) {
        sendError(res, 404, openaiError(outcome.message, "invalid_request_error", null, outcome.code));
        return;
      }
      sendJson(res, 200, { fact: factJson(outcome.fact) });
    } catch (err) {
      const message = badRequest(err);
      if (message === null) throw err;
      sendError(res, 400, openaiError(message));
    }
  };
}
