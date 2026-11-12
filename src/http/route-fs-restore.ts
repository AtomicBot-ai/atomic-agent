import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { FileRestoreStore } from "../tools/os/fs/fs-restore-store.js";
import { openaiError } from "./openai-errors.js";
import { readJsonBody, sendError, sendJson, type HttpHandler } from "./request-context.js";

/**
 * `POST /api/sessions/{id}/fs/restore` — `{ path }` (ATO-563): put back the
 * content a file had before the agent replaced it, from the copy
 * `os.fs.write` / `edit` / `patch` saved (`fs-replace-guard.ts`). The same
 * store and the same write `os.fs.restore` uses, without a model turn: the
 * desktop's Revert button under a reply calls it after the person confirmed,
 * so that click is the approval.
 *
 * Only a file that has a saved copy in the chat's working folder can be
 * written, and only with that copy's bytes: the route cannot put arbitrary
 * content anywhere. The copy stays in the store, like the tool's.
 *
 * `200 { path, bytes, lines, savedAt, savedBefore }`. `400` for a path that
 * is not absolute. `404` with code `session_not_found` for an unknown chat,
 * `no_copy` when nothing was saved for that file (an ordinary edit saves
 * nothing; only a whole-file replacement or a large shrink does), and
 * `copy_gone` when the saved copy file is missing. `409 turn_in_progress`
 * while the chat runs a turn, whose tools could be writing the same file.
 */
export function createRestoreFileHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const id = ctx.params.id ?? "";
    let body: unknown;
    try {
      body = await readJsonBody<unknown>(req);
    } catch (err) {
      sendError(res, 400, openaiError(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    const raw = (body as { path?: unknown } | null)?.path;
    if (typeof raw !== "string" || raw.length === 0 || raw.includes("\0") || !isAbsolute(raw)) {
      sendError(res, 400, openaiError("path must be an absolute file path", "invalid_request_error", "path"));
      return;
    }
    const session = ctx.runtime.sessionStore.load(id);
    if (!session) {
      sendError(res, 404, openaiError(`session not found: ${id}`, "invalid_request_error", null, "session_not_found"));
      return;
    }
    if (ctx.runtime.turnController.isBusy(id) || session.status === "running") {
      sendError(res, 409, openaiError("this chat has a turn in progress; revert the file when it finishes", "invalid_request_error", null, "turn_in_progress"));
      return;
    }
    const absolute = resolve(raw);
    // The tools' store: `<stateDir>/restore`, keyed by the chat's working folder.
    const store = new FileRestoreStore(resolve(ctx.runtime.config.paths.stateDir, "restore"));
    const copy = await store.latestCopy(session.workingDir, absolute);
    if (copy === null) {
      sendError(res, 404, openaiError(`nothing saved for ${absolute} in this chat's folder`, "invalid_request_error", "path", "no_copy"));
      return;
    }
    let content: Buffer;
    try {
      content = await store.readCopy(session.workingDir, copy);
    } catch {
      sendError(res, 404, openaiError(`the saved copy of ${absolute} is gone`, "invalid_request_error", "path", "copy_gone"));
      return;
    }
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
    sendJson(res, 200, {
      path: absolute,
      bytes: copy.bytes,
      lines: copy.lines,
      savedAt: copy.savedAt,
      savedBefore: copy.tool,
    });
  };
}
