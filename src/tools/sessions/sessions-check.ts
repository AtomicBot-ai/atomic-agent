import { compressToolResult } from "../../compressor/result-compressor.js";
import type { SessionChatLine, SessionStore } from "../../session/index.js";
import type { TaskRecord, TaskStore } from "../../tasks/index.js";
import type { ToolDefinition } from "../tool-registry.js";
import { crossSessionSender, stringArg } from "./session-access.js";

export interface SessionsCheckToolOptions {
  taskStore: Pick<TaskStore, "get">;
  sessionStore: Pick<SessionStore, "listChatLines">;
}

/** The answer is clipped here; the whole chat is one `sessions.read` away. */
const ANSWER_CHARS = 6000;

/**
 * `sessions.check { taskId }` — where a message this chat sent with
 * `sessions.send` stands: still queued, running, failed, or answered, and
 * then the reply the other agent gave to it. Only messages this chat sent
 * are visible, and only the reply to that message is returned, so this
 * reads nothing of the other chat the send's approval did not cover.
 */
export function buildSessionsCheckTool(options: SessionsCheckToolOptions): ToolDefinition {
  return {
    name: "sessions.check",
    description:
      "Status and answer of a message sent with sessions.send. Args: { taskId }. Returns the other agent's reply once it has answered.",
    readonly: true,
    untrustedOutput: "another chat",
    async run(rawArgs, ctx) {
      const taskId = stringArg(rawArgs.taskId);
      if (!taskId) {
        return compressToolResult({
          tool: "sessions.check",
          status: "error",
          output: "validation: taskId is required (sessions.send returns it)",
          details: { field: "taskId" },
        });
      }
      const record = options.taskStore.get(taskId);
      if (!record || crossSessionSender(record.userMessage) !== ctx.sessionId) {
        return compressToolResult({
          tool: "sessions.check",
          status: "error",
          output: `no message ${taskId} sent from this chat`,
          details: { taskId },
        });
      }
      const base = { taskId, sessionId: record.sessionId, taskStatus: record.status };
      if (record.status !== "completed" || record.sessionId === null) {
        return compressToolResult({
          tool: "sessions.check",
          status: "ok",
          output: pendingLine(record),
          details: { ...base, answered: false },
        });
      }
      const answer = replyTo(
        options.sessionStore.listChatLines(record.sessionId),
        record.userMessage,
      );
      if (answer === null) {
        return compressToolResult({
          tool: "sessions.check",
          status: "ok",
          output: `the agent in ${record.sessionId} finished but left no reply to this message`,
          details: { ...base, answered: false },
        });
      }
      const clipped =
        answer.length > ANSWER_CHARS ? `${answer.slice(0, ANSWER_CHARS)}…` : answer;
      return compressToolResult(
        {
          tool: "sessions.check",
          status: "ok",
          output: `answer from the agent in ${record.sessionId}:\n${clipped}`,
          details: { ...base, answered: true },
        },
        { maxSummaryLength: ANSWER_CHARS + 200, maxTailLines: 200 },
      );
    },
  };
}

function pendingLine(record: TaskRecord): string {
  switch (record.status) {
    case "pending":
      return `message ${record.id} is queued and not answered yet`;
    case "running":
      return `the agent in ${record.sessionId ?? "the other chat"} is working on message ${record.id}`;
    case "completed":
      return `message ${record.id} finished`;
    default:
      return `message ${record.id} ended as ${record.status}${
        record.lastError ? `: ${record.lastError}` : ""
      }`;
  }
}

/**
 * The first agent reply after the last copy of `message` in the chat.
 * Matched on the exact queued text, so a later message from the person
 * cannot be mistaken for this one.
 */
export function replyTo(lines: readonly SessionChatLine[], message: string): string | null {
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line?.kind === "user" && line.text === message) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line?.kind === "user") return null;
    if (line?.kind === "assistant_reply") return line.text;
  }
  return null;
}
