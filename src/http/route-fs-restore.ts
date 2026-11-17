import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { questionRowIndex, questionTurnEnd } from "../session/session-fork.js";
import { applyFileRestore } from "../tools/os/fs/fs-checkpoint-restore.js";
import {
  FileCheckpointStore,
  fileCheckpointsRoot,
  sha256Of,
  type CheckpointEntry,
} from "../tools/os/fs/fs-checkpoint-store.js";
import { openaiError } from "./openai-errors.js";
import { readJsonBody, sendError, sendJson, type HttpHandler } from "./request-context.js";

/**
 * `POST /api/sessions/{id}/fs/restore` — `{ path, priorQuestions, expectText }`
 * (ATO-563): put one file back as it was before one reply changed it. The
 * desktop's Revert under a reply calls it after the person confirmed, so
 * that click is the approval.
 *
 * The content comes from the file checkpoints (`fs-checkpoint-store.ts`,
 * ATO-1056), the copy the agent takes before every os.fs.write / edit /
 * patch / move / trash / restore, not from the replace guard's store: that
 * one keeps only some replacements and its newest copy can be the turn's
 * own intermediate write. A reply is named the way the rewind routes name
 * a question: `priorQuestions` (questions before it, steers not counted)
 * and `expectText`. Its turn runs from that question's `at` to the next
 * question's; the earliest copy of the path in that window is what the
 * file held before the reply, however many times the reply wrote it.
 *
 * Refusals (nothing is written): `409 point_mismatch` when the stored
 * question differs, `404 no_snapshot` when that reply left no copy of the
 * file (`incomplete: true` when copies from then on were dropped to stay
 * in the store's bounds), `409 changed_later` when a later reply changed
 * the file too (putting the old content back would also undo that one;
 * revert from the latest reply instead), `409 not_restorable` with
 * `reason` for a file noted but not copied (`too_large`, `binary`,
 * `not_a_file`, `unreadable`), `409 turn_in_progress` while the chat runs
 * a turn. A file the reply created is removed, as the rewind does.
 *
 * `200 { path, action: "restore" | "delete" | "unchanged", at, tool }`:
 * `unchanged` when the file already holds that content. The copies stay,
 * so a second Revert answers `unchanged`.
 */
export function createRestoreFileHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const id = ctx.params.id ?? "";
    let body: { path?: unknown; priorQuestions?: unknown; expectText?: unknown } | null;
    try {
      body = (await readJsonBody<unknown>(req)) as typeof body;
    } catch (err) {
      sendError(res, 400, openaiError(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    const raw = body?.path;
    if (typeof raw !== "string" || raw.length === 0 || raw.includes("\0") || !isAbsolute(raw)) {
      sendError(res, 400, openaiError("path must be an absolute file path", "invalid_request_error", "path"));
      return;
    }
    const prior = body?.priorQuestions;
    if (typeof prior !== "number" || !Number.isInteger(prior) || prior < 0) {
      sendError(res, 400, openaiError("priorQuestions must be a non-negative integer: the reply's question, by how many questions come before it", "invalid_request_error", "priorQuestions"));
      return;
    }
    const expectText = body?.expectText;
    if (typeof expectText !== "string") {
      sendError(res, 400, openaiError("expectText must be a string: the text of the reply's question", "invalid_request_error", "expectText"));
      return;
    }
    const session = ctx.runtime.sessionStore.load(id);
    if (!session) {
      sendError(res, 404, openaiError(`session not found: ${id}`, "invalid_request_error", null, "session_not_found"));
      return;
    }
    if (ctx.runtime.turnController.isBusy(id) || session.status === "running") {
      refuse(res, 409, "turn_in_progress", "this chat has a turn in progress; revert the file when it finishes");
      return;
    }
    const turnIndex = questionRowIndex(session, prior);
    const row = turnIndex < 0 ? undefined : session.turns[turnIndex];
    if (row === undefined || row.kind !== "user" || row.text.trim() !== expectText.trim()) {
      refuse(res, 409, "point_mismatch", "the chat's question at that position is not the one given (priorQuestions, expectText), so nothing was changed");
      return;
    }
    const endIndex = questionTurnEnd(session, turnIndex);
    const next = session.turns[endIndex];
    const endAt = next !== undefined && next.kind === "user" ? next.at : Number.POSITIVE_INFINITY;

    const absolute = resolve(raw);
    const store = new FileCheckpointStore(fileCheckpointsRoot(ctx.runtime.config.paths.stateDir));
    const { entries, incomplete } = await store.since(session.id, row.at);
    const ofPath = entries.filter((entry) => resolve(entry.path) === absolute);
    const inTurn = ofPath.filter((entry) => entry.at < endAt);
    const first: CheckpointEntry | undefined = inTurn[0];
    if (first === undefined) {
      sendJson(res, 404, {
        ...openaiError(
          incomplete
            ? `the copy of ${absolute} from before that reply is no longer kept (older copies are dropped to stay in bounds)`
            : `no copy of ${absolute} from that reply: it did not change the file through its file tools, or this chat's copies were removed 30 days after its last one`,
          "invalid_request_error",
          "path",
          "no_snapshot",
        ),
        incomplete,
      });
      return;
    }
    if (ofPath.some((entry) => entry.at >= endAt)) {
      refuse(res, 409, "changed_later", `a later reply in this chat changed ${absolute} too; putting back the older version would undo that one as well, so revert it from the latest reply`);
      return;
    }
    if (first.skipped !== undefined) {
      sendJson(res, 409, {
        ...openaiError(`${absolute} was ${skipWords(first.skipped)}, so no copy of it was kept`, "invalid_request_error", "path", "not_restorable"),
        reason: first.skipped,
      });
      return;
    }
    const now = await diskState(absolute);
    if (now === "other") {
      refuse(res, 409, "not_restorable", `${absolute} is not a file now, so it was left as it is`);
      return;
    }
    const unchanged = first.existed ? now !== "missing" && now.sha256 === first.sha256 : now === "missing";
    const meta = { path: absolute, at: first.at, tool: first.tool };
    if (unchanged) {
      sendJson(res, 200, { ...meta, action: "unchanged" });
      return;
    }
    const action = first.existed ? "restore" : "delete";
    const done = await applyFileRestore(store, session.id, { items: [{ path: absolute, action, entry: first }], notRestorable: [], incomplete });
    const failed = done.failed[0];
    if (failed !== undefined) {
      sendError(res, 500, openaiError(`could not put ${absolute} back: ${failed.error}`, "server_error", "path", "restore_failed"));
      return;
    }
    sendJson(res, 200, { ...meta, action });
  };
}

function refuse(res: Parameters<HttpHandler>[1], status: number, code: string, message: string): void {
  sendError(res, status, openaiError(message, "invalid_request_error", null, code));
}

function skipWords(reason: NonNullable<CheckpointEntry["skipped"]>): string {
  if (reason === "too_large") return "too large";
  if (reason === "binary") return "a binary file";
  if (reason === "not_a_file") return "not a plain file";
  return "unreadable";
}

async function diskState(path: string): Promise<"missing" | "other" | { sha256: string }> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return "other";
    return { sha256: sha256Of(await readFile(path)) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "other";
  }
}
