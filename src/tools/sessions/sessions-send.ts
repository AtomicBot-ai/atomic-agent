import type { DangerousToolOptions } from "../../approval/dangerous-tool.js";
import { compressToolResult } from "../../compressor/result-compressor.js";
import {
  summarizeSessionState,
  type SessionState,
  type SessionStore,
} from "../../session/index.js";
import { TaskValidationError, type TaskRunner } from "../../tasks/index.js";
import type { ToolDefinition } from "../tool-registry.js";
import {
  approveCrossSession,
  chatName,
  crossSessionSender,
  frameCrossSessionMessage,
  stringArg,
} from "./session-access.js";

export interface SessionsSendToolOptions extends DangerousToolOptions {
  sessionStore: Pick<SessionStore, "load">;
  taskRunner: Pick<TaskRunner, "create">;
  /** Opens the chat a `newSession: true` send goes to. */
  createSession(input?: { metadata?: Record<string, unknown> }): SessionState;
  defaultMaxAttempts: number;
}

/** A message longer than this is a document, not a request: put it in a file. */
const MAX_MESSAGE_CHARS = 8000;
/** What the approval prompt shows of the message. */
const PREVIEW_CHARS = 600;

/**
 * `sessions.send { message, sessionId? | newSession? }` — hand a request
 * to the agent in another chat (or in a new chat). The message is queued
 * as a task in that chat; the agent there runs one turn on it when the
 * scheduler picks it up, and `sessions.check { taskId }` reports its
 * answer. Nothing waits here: a turn cannot block on another turn that
 * may sit behind it in the same queue.
 *
 * Every send asks first (`session_cross`). The message reaches the other
 * agent under a header that says it comes from an agent, not from the
 * person. A turn that such a message started cannot send again, so two
 * chats cannot keep each other busy.
 */
export function buildSessionsSendTool(options: SessionsSendToolOptions): ToolDefinition {
  return {
    name: "sessions.send",
    description:
      "Queue a request for the agent in another chat, or in a new chat (newSession: true). Args: { message, sessionId?, newSession? }. Asks the operator first; returns a taskId for sessions.check.",
    readonly: false,
    async run(rawArgs, ctx) {
      const message = typeof rawArgs.message === "string" ? rawArgs.message.trim() : "";
      if (message.length === 0) {
        return invalid("message", "message must be a non-empty string");
      }
      if (message.length > MAX_MESSAGE_CHARS) {
        return invalid(
          "message",
          `message is ${message.length} characters; keep it under ${MAX_MESSAGE_CHARS} (write long material to a file and name the path)`,
        );
      }
      const targetId = stringArg(rawArgs.sessionId);
      const newSession = rawArgs.newSession === true;
      if ((targetId === undefined) === !newSession) {
        return invalid("sessionId", "pass either sessionId or newSession: true, not both");
      }
      if (targetId === ctx.sessionId) {
        return invalid("sessionId", "that is this chat; answer here instead");
      }
      const forwarded = startedByAnotherChat(
        ctx.userGroundingTexts,
        options.sessionStore.load(ctx.sessionId),
      );
      if (forwarded !== null) {
        return compressToolResult({
          tool: "sessions.send",
          status: "error",
          output: `this turn was started by a message from chat ${forwarded}; answer it with reply instead of sending on`,
          details: { reason: "forward_refused", from: forwarded },
        });
      }

      let targetName = "a new chat";
      if (targetId !== undefined) {
        const target = options.sessionStore.load(targetId);
        if (!target) {
          return compressToolResult({
            tool: "sessions.send",
            status: "error",
            output: `no chat with id ${targetId} (ids come from sessions.list)`,
            details: { sessionId: targetId },
          });
        }
        targetName = `"${chatName(summarizeSessionState(target))}"`;
      }

      await approveCrossSession(
        options,
        {
          tool: "sessions.send",
          callerSessionId: ctx.sessionId,
          targetSessionId: targetId ?? null,
          reason: `send a request to the agent in ${targetName}`,
          preview:
            message.length > PREVIEW_CHARS ? `${message.slice(0, PREVIEW_CHARS)}…` : message,
        },
        ctx.signal,
      );

      // Created only after the yes: a refused send leaves no empty chat behind.
      const sessionId =
        targetId ??
        options.createSession({
          metadata: { createdBySession: ctx.sessionId, triggerSource: "agent" },
        }).id;
      try {
        const record = options.taskRunner.create({
          sessionId,
          userMessage: frameCrossSessionMessage(ctx.sessionId, message),
          origin: "agent",
          triggerSource: "agent",
          maxAttempts: options.defaultMaxAttempts,
          maxSteps: null,
        });
        return compressToolResult({
          tool: "sessions.send",
          status: "ok",
          output: `queued for ${targetName} (${sessionId}) as task ${record.id}; it runs when the scheduler picks it up. Get the answer later with sessions.check {"taskId":"${record.id}"}.`,
          details: { taskId: record.id, sessionId, newSession },
        });
      } catch (err) {
        if (err instanceof TaskValidationError) {
          return invalid(err.field, err.message);
        }
        throw err;
      }
    },
  };
}

/**
 * The chat whose message started the caller's current turn, if one did.
 * The step's own copy of the person's messages (`userGroundingTexts`,
 * newest last) is read first: the stored row lags the live transcript
 * until the turn's first checkpoint. The stored transcript covers a host
 * that does not compute it.
 */
function startedByAnotherChat(
  liveUserTexts: readonly string[] | undefined,
  stored: SessionState | null,
): string | null {
  const latestLive = liveUserTexts?.at(-1);
  if (latestLive !== undefined) return crossSessionSender(latestLive);
  if (!stored) return null;
  for (let i = stored.turns.length - 1; i >= 0; i -= 1) {
    const turn = stored.turns[i];
    if (turn?.kind === "user" && turn.steered !== true) return crossSessionSender(turn.text);
  }
  return null;
}

function invalid(field: string, reason: string) {
  return compressToolResult({
    tool: "sessions.send",
    status: "error",
    output: `validation: ${field}: ${reason}`,
    details: { field, reason },
  });
}
