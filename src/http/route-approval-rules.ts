import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import {
  getApprovalRulesPath,
  getProjectApprovalRulesPath,
} from "../approval/approval-rules-store.js";
import { openaiError } from "./openai-errors.js";
import {
  sendError,
  sendJson,
  type HandlerContext,
  type HttpHandler,
} from "./request-context.js";

/**
 * The folder a listing is about: the selected session's, an explicit
 * absolute `workingDir`, or the one the server was started in.
 */
function resolveFolder(
  ctx: HandlerContext,
  workingDir: string | null,
  sessionId: string | null,
): { dir: string } | { status: number; message: string } {
  if (sessionId) {
    const session = ctx.runtime.sessionStore.load(sessionId);
    if (!session) return { status: 404, message: "session not found" };
    return { dir: session.workingDir };
  }
  if (workingDir) {
    if (!isAbsolute(workingDir)) {
      return { status: 400, message: "workingDir must be an absolute path" };
    }
    if (!existsSync(workingDir) || !statSync(workingDir).isDirectory()) {
      return { status: 404, message: "workingDir is not a folder" };
    }
    return { dir: workingDir };
  }
  return { dir: ctx.runtime.capabilities.workingDir };
}

/**
 * `GET /api/approval-rules?workingDir=<abs>|sessionId=<id>` — the saved
 * approval rules (ATO-1141). `rules` are the global file's (allow, ask,
 * deny; deletable); `projectRules` are the ask / deny rules of the
 * folder's own `.atomic-agent/approval-rules.json`, read-only here: the
 * project file is edited by hand, and an allow in it is never honoured.
 */
export function createListApprovalRulesHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const store = ctx.runtime.approvals.getRules();
    if (store === undefined) {
      sendError(res, 503, openaiError("approval rules are not available"));
      return;
    }
    const params = new URL(req.url ?? "/", "http://localhost").searchParams;
    const folder = resolveFolder(ctx, params.get("workingDir"), params.get("sessionId"));
    if ("status" in folder) {
      sendError(res, folder.status, openaiError(folder.message));
      return;
    }
    const project = store.canonicalDir?.(folder.dir) ?? folder.dir;
    sendJson(res, 200, {
      rules: store.list(),
      globalPath: getApprovalRulesPath(ctx.runtime.config.paths.stateDir),
      projectPath: getProjectApprovalRulesPath(project),
      projectRules: store.projectRules?.(project) ?? [],
    });
  };
}

/**
 * `DELETE /api/approval-rules/{id}` — remove a rule from the global file.
 * Project-file rules are not deletable here (404): they belong to the
 * project's own file.
 */
export function createDeleteApprovalRuleHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const store = ctx.runtime.approvals.getRules();
    if (store === undefined) {
      sendError(res, 503, openaiError("approval rules are not available"));
      return;
    }
    const id = ctx.params.id;
    if (!id) {
      sendError(res, 400, openaiError("rule id is required"));
      return;
    }
    if (!store.remove(id)) {
      sendError(res, 404, openaiError(`approval rule not found: ${id}`));
      return;
    }
    sendJson(res, 200, { removed: true, id });
  };
}
