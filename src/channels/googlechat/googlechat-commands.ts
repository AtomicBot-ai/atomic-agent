/**
 * Slash commands for the Google Chat channel: `/help`, `/status`,
 * `/new`, `/model`, `/cancel`. Typed as plain text (the Chat app does
 * not need them registered). Owner-gated already: the inbound handler
 * drops every message from outside `ownerIds` before this runs.
 */

import type { AgentRuntime } from "../../runtime/runtime-contract.js";
import type { ChatSessionMap } from "../chat-session-map.js";
import { runModelCommand } from "../model-command.js";

export interface GoogleChatCommandContext {
  runtime: AgentRuntime;
  sessions: Pick<ChatSessionMap, "get" | "rotate">;
  inflight: Map<string, AbortController>;
  pendingApprovals: (space: string) => number;
  releaseApprovalSession: (sessionId: string) => void;
  reply: (text: string) => Promise<void>;
}

export const GOOGLE_CHAT_HELP_TEXT = [
  "atomic-agent: Google Chat remote control",
  "",
  "Write to me here and I'll act on it. Every space is its own conversation.",
  "",
  "Commands:",
  "  /help: this message",
  "  /status: this space's session and anything waiting on you",
  "  /new: start a fresh session in this space (the current one is archived)",
  "  /model: show the provider and model; /model <provider> [model-id] switches",
  "  /cancel: stop the turn running in this space",
  "  /whoami: your own Google Chat id, for channels.googlechat.ownerIds",
  "",
  'Approvals: answer "yes <code>" or "no <code>" from the prompt.',
].join("\n");

export async function handleGoogleChatCommand(
  text: string,
  space: string,
  ctx: GoogleChatCommandContext,
): Promise<void> {
  const [verb = "", ...rest] = text.split(/\s+/);
  switch (verb.toLowerCase()) {
    case "/start":
    case "/help":
      await ctx.reply(GOOGLE_CHAT_HELP_TEXT);
      return;
    case "/status": {
      const current = ctx.sessions.get(space).current;
      const lines = [
        current ? `This space is on session ${current}.` : "No session for this space yet.",
        ctx.inflight.has(space) ? "A turn is running." : "Nothing is running.",
      ];
      const open = ctx.pendingApprovals(space);
      if (open > 0) lines.push(`${open} approval${open === 1 ? "" : "s"} waiting for your answer.`);
      await ctx.reply(lines.join("\n"));
      return;
    }
    case "/model":
      await ctx.reply(
        await runModelCommand(rest, {
          runtime: ctx.runtime,
          sessionId: ctx.sessions.get(space).current,
          code: (t) => `\`${t}\``,
        }),
      );
      return;
    case "/new": {
      const previous = ctx.sessions.get(space).current;
      ctx.sessions.rotate(space);
      // A turn still running keeps its approvals until it settles.
      if (previous && !ctx.inflight.has(space)) ctx.releaseApprovalSession(previous);
      await ctx.reply(
        previous
          ? `Started a new session for this space. Previous session ${previous} archived.`
          : "Started a new session for this space.",
      );
      return;
    }
    case "/cancel": {
      const controller = ctx.inflight.get(space);
      if (!controller) {
        await ctx.reply("No turn in progress in this space.");
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
