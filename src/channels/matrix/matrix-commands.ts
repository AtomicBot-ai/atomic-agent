/**
 * Slash commands for the Matrix channel: `/help`, `/status`, `/new`,
 * `/model`, `/cancel`. Owner-gated already: the inbound handler drops
 * every message from outside `ownerIds` before this runs.
 */

import type { AgentRuntime } from "../../runtime/runtime-contract.js";
import type { ChatSessionMap } from "../chat-session-map.js";
import { runModelCommand } from "../model-command.js";

export interface MatrixCommandContext {
  runtime: AgentRuntime;
  sessions: Pick<ChatSessionMap, "get" | "rotate">;
  inflight: Map<string, AbortController>;
  pendingApprovals: (roomId: string) => number;
  releaseApprovalSession: (sessionId: string) => void;
  reply: (text: string) => Promise<void>;
}

export const MATRIX_HELP_TEXT = [
  "atomic-agent: Matrix remote control",
  "",
  "Write to me in this room and I'll act on it. Every room is its own conversation.",
  "Encrypted rooms are not supported yet.",
  "",
  "Commands:",
  "  /help: this message",
  "  /status: this room's session and anything waiting on you",
  "  /new: start a fresh session in this room (the current one is archived)",
  "  /model: show the provider and model; /model <provider> [model-id] switches",
  "  /cancel: stop the turn running in this room",
  "",
  'Approvals: answer "yes <code>" or "no <code>" from the prompt.',
].join("\n");

export async function handleMatrixCommand(
  text: string,
  roomId: string,
  ctx: MatrixCommandContext,
): Promise<void> {
  const [verb = "", ...rest] = text.split(/\s+/);
  switch (verb.toLowerCase()) {
    case "/start":
    case "/help":
      await ctx.reply(MATRIX_HELP_TEXT);
      return;
    case "/status": {
      const current = ctx.sessions.get(roomId).current;
      const lines = [
        current ? `This room is on session ${current}.` : "No session for this room yet.",
        ctx.inflight.has(roomId) ? "A turn is running." : "Nothing is running.",
      ];
      const open = ctx.pendingApprovals(roomId);
      if (open > 0) lines.push(`${open} approval${open === 1 ? "" : "s"} waiting for your answer.`);
      await ctx.reply(lines.join("\n"));
      return;
    }
    case "/model":
      await ctx.reply(
        await runModelCommand(rest, {
          runtime: ctx.runtime,
          sessionId: ctx.sessions.get(roomId).current,
          code: (t) => t,
        }),
      );
      return;
    case "/new": {
      const previous = ctx.sessions.get(roomId).current;
      ctx.sessions.rotate(roomId);
      // A turn still running keeps its approvals until it settles.
      if (previous && !ctx.inflight.has(roomId)) ctx.releaseApprovalSession(previous);
      await ctx.reply(
        previous
          ? `Started a new session for this room. Previous session ${previous} archived.`
          : "Started a new session for this room.",
      );
      return;
    }
    case "/cancel": {
      const controller = ctx.inflight.get(roomId);
      if (!controller) {
        await ctx.reply("No turn in progress in this room.");
        return;
      }
      controller.abort();
      await ctx.reply("Cancelling the current turn…");
      return;
    }
    default:
      await ctx.reply(`Unknown command: ${verb}. Try /help.`);
  }
}
