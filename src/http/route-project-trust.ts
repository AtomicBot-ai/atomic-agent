import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  answerProjectTrust,
  inspectProjectTrust,
  ProjectTrustConflictError,
  type ProjectTrustAnswer,
} from "../runtime/project-trust.js";
import { openaiError } from "./openai-errors.js";
import {
  readJsonBody,
  sendError,
  sendJson,
  type HandlerContext,
  type HttpHandler,
} from "./request-context.js";

interface AnswerBody {
  workingDir?: unknown;
  sessionId?: unknown;
  answer?: unknown;
  questionId?: unknown;
}

/**
 * Folder a request is about: an explicit absolute `workingDir`, the
 * selected session's folder, or the folder the server was started in.
 */
function resolveFolder(ctx: HandlerContext, workingDir: unknown, sessionId: unknown): { dir: string } | { status: number; message: string } {
  if (typeof sessionId === "string" && sessionId) {
    const session = ctx.runtime.sessionStore.load(sessionId);
    if (!session) return { status: 404, message: "session not found" };
    return { dir: session.workingDir };
  }
  if (workingDir !== undefined && workingDir !== null && workingDir !== "") {
    if (typeof workingDir !== "string" || !isAbsolute(workingDir)) return { status: 400, message: "workingDir must be an absolute path" };
    if (!existsSync(workingDir) || !statSync(workingDir).isDirectory()) return { status: 404, message: "workingDir is not a folder" };
    return { dir: workingDir };
  }
  return { dir: ctx.runtime.capabilities.workingDir };
}

/**
 * `GET /api/project-trust?workingDir=<abs>|sessionId=<id>` — the pending
 * trust question for a folder's project skills and instruction files
 * (ATO-298). `question` is null when there is nothing to ask. Without an
 * answer every pending item stays unloaded.
 */
export function createProjectTrustStatusHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const params = new URL(req.url ?? "/", "http://localhost").searchParams;
    const folder = resolveFolder(ctx, params.get("workingDir") ?? undefined, params.get("sessionId") ?? undefined);
    if ("status" in folder) { sendError(res, folder.status, openaiError(folder.message)); return; }
    sendJson(res, 200, inspectProjectTrust(ctx.runtime.config, folder.dir));
  };
}

/**
 * `POST /api/project-trust` with `{ workingDir? | sessionId?, answer:
 * "trust" | "decline", questionId }` — record the operator's answer for
 * exactly the items that question listed. A `questionId` that no longer
 * matches (a new skill or file appeared) answers `409` with the fresh
 * status and records nothing. The local skill catalog is refreshed; cloud
 * sessions reread the answer on their next step.
 */
export function createProjectTrustAnswerHandler(): HttpHandler {
  return async (req, res, ctx) => {
    let body: AnswerBody;
    try {
      body = await readJsonBody<AnswerBody>(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 400, openaiError(`Invalid JSON: ${message}`));
      return;
    }
    if (body.answer !== "trust" && body.answer !== "decline") {
      sendError(res, 400, openaiError('answer must be "trust" or "decline"'));
      return;
    }
    if (typeof body.questionId !== "string" || !body.questionId) {
      sendError(res, 400, openaiError("questionId is required"));
      return;
    }
    const folder = resolveFolder(ctx, body.workingDir, body.sessionId);
    if ("status" in folder) { sendError(res, folder.status, openaiError(folder.message)); return; }
    try {
      const status = answerProjectTrust(ctx.runtime.config, folder.dir, body.answer as ProjectTrustAnswer, body.questionId);
      await ctx.runtime.refreshSkills();
      sendJson(res, 200, status);
    } catch (err) {
      if (err instanceof ProjectTrustConflictError) {
        sendJson(res, 409, { error: openaiError(err.message, "invalid_request_error", null, "question_changed").error, status: err.status });
        return;
      }
      throw err;
    }
  };
}
