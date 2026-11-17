import type { DangerousToolOptions } from "../../approval/dangerous-tool.js";
import { compressToolResult } from "../../compressor/result-compressor.js";
import {
  summarizeSessionState,
  type SessionChatLine,
  type SessionStore,
} from "../../session/index.js";
import type { ToolDefinition } from "../tool-registry.js";
import {
  approveCrossSession,
  chatName,
  limitArg,
  stringArg,
} from "./session-access.js";

export interface SessionsReadToolOptions extends DangerousToolOptions {
  sessionStore: Pick<SessionStore, "load" | "listChatLines">;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
/** One message is clipped here, so a pasted log cannot fill the result. */
const MESSAGE_CHARS = 2000;

/**
 * `sessions.read { sessionId, limit? }` — the last `limit` visible
 * messages of a chat: what the person wrote and the agent's replies, in
 * order. Never tool calls, tool output, attached files or reasoning:
 * those stay in the chat they belong to. Reading any chat but the
 * caller's own asks first (`session_cross`).
 */
export function buildSessionsReadTool(options: SessionsReadToolOptions): ToolDefinition {
  return {
    name: "sessions.read",
    description:
      "Read the last messages of another chat (the person's words and the agent's replies only). Args: { sessionId, limit? }. Asks the operator first.",
    readonly: true,
    untrustedOutput: "another chat",
    async run(rawArgs, ctx) {
      const sessionId = stringArg(rawArgs.sessionId);
      if (!sessionId) {
        return compressToolResult({
          tool: "sessions.read",
          status: "error",
          output: "validation: sessionId is required (ids come from sessions.list)",
          details: { field: "sessionId" },
        });
      }
      const state = options.sessionStore.load(sessionId);
      if (!state) {
        return compressToolResult({
          tool: "sessions.read",
          status: "error",
          output: `no chat with id ${sessionId} (ids come from sessions.list)`,
          details: { sessionId },
        });
      }
      const name = chatName(summarizeSessionState(state));
      await approveCrossSession(
        options,
        {
          tool: "sessions.read",
          callerSessionId: ctx.sessionId,
          targetSessionId: sessionId,
          reason: `read the messages of another chat: "${name}"`,
        },
        ctx.signal,
      );
      const limit = limitArg(rawArgs.limit, DEFAULT_LIMIT, MAX_LIMIT);
      const all = options.sessionStore.listChatLines(sessionId);
      const lines = all.slice(-limit);
      const output =
        lines.length === 0
          ? `"${name}" has no messages yet`
          : [
              `"${name}" (${sessionId}), last ${lines.length} of ${all.length} messages:`,
              ...lines.map(renderLine),
            ].join("\n");
      return compressToolResult(
        {
          tool: "sessions.read",
          status: "ok",
          output,
          details: { sessionId, name, shown: lines.length, total: all.length },
        },
        { maxSummaryLength: 12000, maxTailLines: 400 },
      );
    },
  };
}

function renderLine(line: SessionChatLine): string {
  const who = line.kind === "user" ? "person" : "agent";
  const text =
    line.text.length > MESSAGE_CHARS ? `${line.text.slice(0, MESSAGE_CHARS)}…` : line.text;
  return `${who}: ${text}`;
}
