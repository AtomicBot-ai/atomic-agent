import { formatProblems } from "../mentions/index.js";
import { openaiError } from "./openai-errors.js";
import { readJsonBody, sendError, sendJson, type HandlerContext, type HttpHandler } from "./request-context.js";
import { checkWorkingDir, refuseDeviceFolder } from "./session-working-dir.js";

/**
 * `@` mentions for the desktop (ATO-2472), the same expansion the
 * terminal runs in process (`runtime.mentions`, src/mentions/):
 *
 *   POST /api/mentions/expand { text, sessionId? | workingDir? }
 *        → 200 { text }           the message with its mentions inlined
 *   GET  /api/problems?sessionId=|workingDir=
 *        → 200 { state, text, files? }   `state`: off | no_server | ok
 *
 * The folder is a stored chat's own (`sessionId`), else an absolute
 * `workingDir`, else the one serve was started in; nothing outside it is
 * read. A paired phone cannot name a folder (`refuseDeviceFolder`).
 * `501` when the runtime has no mention services. A body is capped like
 * every JSON route; `text` at MAX_TEXT characters.
 */

export const MAX_TEXT = 200_000;

type Folder = { dir: string } | { status: number; message: string; param: string };

function folderOf(ctx: HandlerContext, sessionId: unknown, workingDir: unknown): Folder {
  if (typeof sessionId === "string" && sessionId.length > 0) {
    const session = ctx.runtime.sessionStore.load(sessionId);
    if (!session) return { status: 404, message: "session not found", param: "sessionId" };
    return { dir: session.workingDir };
  }
  if (workingDir !== undefined && workingDir !== null && workingDir !== "") {
    const checked = checkWorkingDir(workingDir);
    if (!checked.ok) return { status: 400, message: checked.error, param: "workingDir" };
    return { dir: checked.dir };
  }
  return { dir: ctx.runtime.capabilities.workingDir };
}

function sendFolderError(res: Parameters<HttpHandler>[1], folder: Exclude<Folder, { dir: string }>): void {
  const type = folder.status === 404 ? "not_found_error" : "invalid_request_error";
  sendError(res, folder.status, openaiError(folder.message, type, folder.param));
}

export function createExpandMentionsHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const mentions = ctx.runtime.mentions;
    if (!mentions) {
      sendError(res, 501, openaiError("this runtime has no mention expansion", "server_error"));
      return;
    }
    let body: unknown;
    try {
      body = await readJsonBody<unknown>(req);
    } catch (error) {
      sendError(res, 400, openaiError(error instanceof Error ? error.message : "invalid body", "invalid_request_error", null, "invalid_body"));
      return;
    }
    const b = (body !== null && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    if (typeof b.text !== "string" || b.text.length > MAX_TEXT) {
      sendError(res, 400, openaiError(`text must be a string of at most ${MAX_TEXT} characters`, "invalid_request_error", "text"));
      return;
    }
    if (b.workingDir !== undefined && refuseDeviceFolder(res, ctx, "workingDir")) return;
    const folder = folderOf(ctx, b.sessionId, b.workingDir);
    if (!("dir" in folder)) return sendFolderError(res, folder);
    sendJson(res, 200, { text: await mentions.expand(b.text, folder.dir) });
  };
}

export function createProblemsHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const mentions = ctx.runtime.mentions;
    if (!mentions) {
      sendError(res, 501, openaiError("this runtime has no mention expansion", "server_error"));
      return;
    }
    const params = new URL(req.url ?? "/", "http://localhost").searchParams;
    if (params.has("workingDir") && refuseDeviceFolder(res, ctx, "workingDir")) return;
    const folder = folderOf(ctx, params.get("sessionId"), params.get("workingDir"));
    if (!("dir" in folder)) return sendFolderError(res, folder);
    const result = await mentions.problems(folder.dir);
    sendJson(res, 200, {
      state: result.state,
      text: formatProblems(result),
      ...(result.state === "ok" ? { servers: result.servers, files: result.files } : {}),
    });
  };
}
