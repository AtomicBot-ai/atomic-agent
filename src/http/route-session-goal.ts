import {
  buildGoalContinuationMessage,
  buildGoalKickoffMessage,
  createGoalState,
  readGoalState,
  resumeGoalState,
  setGoalStatus,
  statusLabel,
  withGoalState,
  type GoalState,
} from "../agent/goal/index.js";
import { createEmptySessionState, type SessionState } from "../session/index.js";
import { openaiError } from "./openai-errors.js";
import {
  readJsonBody,
  sendError,
  sendJson,
  type HandlerContext,
  type HttpHandler,
} from "./request-context.js";
import { checkWorkingDir } from "./session-working-dir.js";

/**
 * Goal mode over HTTP (ATO-1040): what the TUI's `/goal`, `/goal pause`,
 * `/goal resume` and `/goal clear` do (src/tui/goal/goal-commands.ts),
 * for a client that is not the TUI (the desktop app).
 *
 *   GET  /api/sessions/{id}/goal   { sessionId, goal, running }
 *   POST /api/sessions/{id}/goal   { action: "set", criteria, maxRounds?, workingDir? }
 *                                  { action: "pause" | "resume" | "clear" }
 *
 * `set` and `resume` store the goal and answer `message`, the text the
 * client sends next through `POST /v1/chat/completions` (the TUI sends
 * the same text); an extensions request on a chat whose stored goal is
 * active runs as goal rounds (chat-goal.ts). `pause` and `clear` on a
 * running goal land after its current round through `runtime.controlGoal`
 * and answer `pending: true`. Shell checks are not set here: a stored
 * goal keeps the checks it has, the HTTP surface adds none.
 */

export type GoalAction =
  | { action: "set"; criteria: string[]; maxRounds?: number }
  | { action: "pause" }
  | { action: "resume" }
  | { action: "clear" };

export interface GoalActionContext {
  stored: GoalState | null;
  /** A turn, or a goal run between its rounds, is in flight on the chat. */
  turnRunning: boolean;
  /** `runtime.controlGoal` for this chat: `false` when no goal runs there. */
  controlGoal: (verb: "pause" | "clear") => boolean;
  now: number;
}

export type GoalActionOutcome =
  | {
      ok: true;
      /** The goal to store; `undefined` leaves the stored one alone. */
      store?: GoalState | null;
      /** The goal as the client should show it now. */
      goal: GoalState | null;
      pending?: true;
      message?: string;
    }
  | { ok: false; code: string; error: string };

/** The decisions, the TUI's rules one for one; pure so tests need no server. */
export function decideGoalAction(action: GoalAction, ctx: GoalActionContext): GoalActionOutcome {
  const { stored } = ctx;
  const refuse = (code: string, error: string): GoalActionOutcome => ({ ok: false, code, error });
  switch (action.action) {
    case "set": {
      if (ctx.turnRunning) return refuse("turn_in_progress", "a turn is running: set the goal when it ends");
      const goal = createGoalState(
        {
          criteria: action.criteria,
          checks: stored?.checks ?? [],
          ...(action.maxRounds === undefined ? {} : { maxRounds: action.maxRounds }),
        },
        ctx.now,
      );
      return { ok: true, store: goal, goal, message: buildGoalKickoffMessage(goal) };
    }
    case "pause": {
      if (!stored) return refuse("no_goal", "no goal to pause");
      if (stored.status !== "active") {
        return refuse("goal_not_running", `the goal is not running (${statusLabel(stored.status)})`);
      }
      if (ctx.controlGoal("pause")) return { ok: true, goal: stored, pending: true };
      const goal = setGoalStatus(stored, "paused", ctx.now, "paused by you");
      return { ok: true, store: goal, goal };
    }
    case "resume": {
      if (!stored) return refuse("no_goal", "no goal to resume");
      if (stored.status === "complete") return refuse("goal_complete", "the goal is already complete");
      if (ctx.turnRunning) return refuse("turn_in_progress", "a turn is running: resume the goal when it ends");
      const goal = resumeGoalState(stored, ctx.now);
      const message = goal.roundsUsed > 0
        ? buildGoalContinuationMessage(goal, [])
        : buildGoalKickoffMessage(goal);
      return { ok: true, store: goal, goal, message };
    }
    case "clear": {
      if (!stored) return refuse("no_goal", "no goal to clear");
      if (stored.status === "active" && ctx.controlGoal("clear")) return { ok: true, goal: null, pending: true };
      return { ok: true, store: null, goal: null };
    }
  }
}

/** The body as an action, or why not (a `400`). */
export function parseGoalAction(body: unknown): { ok: true; action: GoalAction } | { ok: false; error: string; param: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "body must be a JSON object", param: "action" };
  }
  const b = body as Record<string, unknown>;
  if (b.action === "pause" || b.action === "resume" || b.action === "clear") return { ok: true, action: { action: b.action } };
  if (b.action !== "set") return { ok: false, error: "action must be set, pause, resume or clear", param: "action" };
  if (!Array.isArray(b.criteria) || !b.criteria.every((c) => typeof c === "string")) {
    return { ok: false, error: "criteria must be an array of strings", param: "criteria" };
  }
  const criteria = (b.criteria as string[]).map((c) => c.trim()).filter((c) => c.length > 0);
  if (criteria.length === 0) return { ok: false, error: "a goal needs at least one criterion", param: "criteria" };
  if (b.maxRounds !== undefined && (typeof b.maxRounds !== "number" || !Number.isInteger(b.maxRounds) || b.maxRounds < 1)) {
    return { ok: false, error: "maxRounds must be a positive integer", param: "maxRounds" };
  }
  return {
    ok: true,
    action: { action: "set", criteria, ...(typeof b.maxRounds === "number" ? { maxRounds: b.maxRounds } : {}) },
  };
}

/** This process's turn, another process's (the store's `running`), or a goal between rounds. */
function turnRunningOn(ctx: HandlerContext, session: SessionState): boolean {
  return ctx.runtime.turnController.isBusy(session.id) ||
    session.status === "running" ||
    ctx.completionRegistry.hasSession(session.id);
}

export function createGetSessionGoalHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const id = ctx.params.id ?? "";
    const session = ctx.runtime.sessionStore.load(id);
    if (!session) {
      sendError(res, 404, openaiError(`session not found: ${id}`, "invalid_request_error", null, "session_not_found"));
      return;
    }
    sendJson(res, 200, { sessionId: id, goal: readGoalState(session.metadata), running: turnRunningOn(ctx, session) });
  };
}

export function createSessionGoalActionHandler(): HttpHandler {
  return async (req, res, ctx) => {
    const id = ctx.params.id ?? "";
    if (!id || /[\r\n\x00]/.test(id)) {
      sendError(res, 400, openaiError("session id is required"));
      return;
    }
    let body: unknown;
    try {
      body = await readJsonBody<unknown>(req);
    } catch (err) {
      sendError(res, 400, openaiError(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    const parsed = parseGoalAction(body);
    if (!parsed.ok) {
      sendError(res, 400, openaiError(parsed.error, "invalid_request_error", parsed.param));
      return;
    }
    let session = ctx.runtime.sessionStore.load(id);
    if (!session) {
      // A goal can open a chat, as `/goal` can in a fresh TUI chat; in the
      // folder given (ATO-731), else the server's own.
      if (parsed.action.action !== "set") {
        sendError(res, 404, openaiError(`session not found: ${id}`, "invalid_request_error", null, "session_not_found"));
        return;
      }
      const rawDir = (body as { workingDir?: unknown }).workingDir;
      let workingDir = ctx.runtime.capabilities.workingDir;
      if (rawDir !== undefined && rawDir !== null) {
        const check = checkWorkingDir(rawDir);
        if (!check.ok) {
          sendError(res, 400, openaiError(check.error, "invalid_request_error", "workingDir"));
          return;
        }
        workingDir = check.dir;
      }
      session = createEmptySessionState({ id, workingDir, metadata: { source: "openai-chat" } });
    }
    const current = session;
    const outcome = decideGoalAction(parsed.action, {
      stored: readGoalState(current.metadata),
      turnRunning: turnRunningOn(ctx, current),
      controlGoal: (verb) => ctx.runtime.controlGoal?.(current.id, verb) ?? false,
      now: Date.now(),
    });
    if (!outcome.ok) {
      sendError(res, 409, openaiError(outcome.error, "invalid_request_error", null, outcome.code));
      return;
    }
    if (outcome.store !== undefined) {
      ctx.runtime.sessionStore.save({ ...current, metadata: withGoalState(current.metadata, outcome.store) });
    }
    sendJson(res, 200, {
      sessionId: id,
      goal: outcome.goal,
      ...(outcome.pending ? { pending: true } : {}),
      ...(outcome.message === undefined ? {} : { message: outcome.message }),
    });
  };
}
