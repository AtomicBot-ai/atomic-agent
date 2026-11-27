import type { IncomingMessage, ServerResponse } from "node:http";

import { FolderRejectedError, type FileIndexApi } from "../tools/files/index.js";
import { openaiError } from "./openai-errors.js";
import { readJsonBody, sendError, sendJson, type HandlerContext, type HttpHandler } from "./request-context.js";

/**
 * "My files" (ATO-1621, epic ATO-980): the folders the person chose for
 * the agent to index, and how far indexing got. The desktop (ATO-1624)
 * codes to these shapes:
 *
 *   GET    /api/files/folders          → 200 { folders: Folder[] }
 *   POST   /api/files/folders {path}   → 200 { folder: Folder }
 *                                        400 { error: { code, message } }
 *   DELETE /api/files/folders {path}   → 200 { removed: boolean }
 *   GET    /api/files/status           → 200 Status
 *   POST   /api/files/retry            → 200 { requeued: number }
 *
 * `retry` (ATO-2501) reads again the skipped files a reader turned on
 * since can read: scans, photos and audio after `vision.indexFiles` is
 * switched on or the OCR data is in place. Status also carries
 * `ocrPages` and `skippedReasons` (`[{ reason, count }]`).
 *
 * The 400 `code` is one of `not_absolute`, `not_found`,
 * `not_a_directory`, `already_added`, `inside_added`, `too_broad`
 * (`tools/files/folder-validation.ts`). A runtime without a file index
 * answers 501, like `/api/memory/embeddings/reconnect`. Same auth as
 * every other `/api` route.
 */
export function createListFileFoldersHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const index = indexOr501(res, ctx);
    if (index) sendJson(res, 200, { folders: index.listFolders() });
  };
}

export function createAddFileFolderHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const index = indexOr501(res, ctx);
    if (!index) return;
    const path = await readPath(req, res);
    if (path === undefined) return;
    try {
      sendJson(res, 200, { folder: await index.addFolder(path) });
    } catch (error) {
      if (!sendRejection(res, error)) throw error;
    }
  };
}

export function createRemoveFileFolderHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const index = indexOr501(res, ctx);
    if (!index) return;
    const path = await readPath(req, res);
    if (path === undefined) return;
    try {
      sendJson(res, 200, { removed: await index.removeFolder(path) });
    } catch (error) {
      if (!sendRejection(res, error)) throw error;
    }
  };
}

export function createFileIndexStatusHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const index = indexOr501(res, ctx);
    if (index) sendJson(res, 200, index.status());
  };
}

export function createRetrySkippedFilesHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const index = indexOr501(res, ctx);
    if (index) sendJson(res, 200, { requeued: index.retrySkipped() });
  };
}

function indexOr501(res: ServerResponse, ctx: HandlerContext): FileIndexApi | null {
  const index = ctx.runtime.fileIndex;
  if (!index) {
    sendError(res, 501, openaiError("this runtime has no file index", "server_error"));
    return null;
  }
  return index;
}

/** `{ path }` from the body; answers the 400 itself and returns `undefined` on a bad body. */
async function readPath(req: IncomingMessage, res: ServerResponse): Promise<string | undefined> {
  let body: unknown;
  try {
    body = await readJsonBody<unknown>(req);
  } catch (error) {
    sendError(res, 400, openaiError(error instanceof Error ? error.message : "invalid body", "invalid_request_error", null, "invalid_body"));
    return undefined;
  }
  const path = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as { path?: unknown }).path : undefined;
  if (typeof path !== "string" || path.length === 0) {
    sendError(res, 400, openaiError("pass the folder as an absolute path in `path`", "invalid_request_error", "path", "not_absolute"));
    return undefined;
  }
  return path;
}

function sendRejection(res: ServerResponse, error: unknown): boolean {
  if (!(error instanceof FolderRejectedError)) return false;
  sendError(res, 400, openaiError(error.message, "invalid_request_error", "path", error.code));
  return true;
}
