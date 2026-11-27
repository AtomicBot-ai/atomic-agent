/**
 * Commands in Linear comments (ATO-2464): `@agent /status`, `/new`,
 * `/cancel`, `/help`. Linear has no slash commands for apps, so they ride
 * in the comment that mentions the agent, the same words the Telegram,
 * Discord and Teams channels answer. As on Discord, a lone `stop`,
 * `cancel` or `status` after the mention counts too: "stop" sent as a
 * request would otherwise queue a whole new turn behind the one it meant
 * to end. Only an exact single word maps, so "@agent stop the deploy" is
 * a normal request.
 */

import type { ChatSessionMap } from "../chat-session-map.js";
import type { LinearTurnQueue } from "./linear-turn-queue.js";

export type LinearCommand = "status" | "new" | "cancel" | "help";

const WORDS: Readonly<Record<string, LinearCommand>> = {
  "/status": "status",
  "/new": "new",
  "/reset": "new",
  "/cancel": "cancel",
  "/stop": "cancel",
  "/help": "help",
  status: "status",
  stop: "cancel",
  cancel: "cancel",
};

export const LINEAR_HELP_TEXT = [
  "**Atomic Agent on Linear**",
  "Mention me in a comment and I work on the request; every issue is one conversation.",
  "- `@agent /status`: this issue's session and whether I am busy",
  "- `@agent /new`: start a fresh session on this issue (the current one is archived)",
  "- `@agent /cancel`: stop what I am doing here, queued requests included",
  "- Approvals: reply `yes <code>` or `no <code>` to the comment that asks",
].join("\n");

/** The command `ask` (the comment without the mention) stands for, or `null`. */
export function parseLinearCommand(ask: string): LinearCommand | null {
  const word = ask.trim().toLowerCase().replace(/[.!]+$/, "");
  return Object.hasOwn(WORDS, word) ? WORDS[word]! : null;
}

export interface LinearCommandContext {
  issueId: string;
  sessions: Pick<ChatSessionMap, "get" | "rotate">;
  turns: LinearTurnQueue;
  /** Approvals still waiting on this issue. */
  pendingApprovals: number;
  releaseApprovalSession?: (sessionId: string) => void;
}

/** Run `command` on the issue and return the comment to post. */
export function runLinearCommand(command: LinearCommand, ctx: LinearCommandContext): string {
  switch (command) {
    case "help":
      return LINEAR_HELP_TEXT;
    case "status": {
      const current = ctx.sessions.get(ctx.issueId).current;
      if (!current) return "No session on this issue yet. Mention me with a request to start one.";
      const held = ctx.turns.size(ctx.issueId);
      const busy = held === 0 ? " Idle." : held === 1 ? " Working on a request." : ` Working on a request, ${held - 1} more waiting.`;
      const open = ctx.pendingApprovals;
      const approvals = open > 0 ? ` ${open} approval${open === 1 ? "" : "s"} waiting for an answer.` : "";
      return `This issue is on session \`${current}\`.${busy}${approvals}`;
    }
    case "new": {
      const previous = ctx.sessions.get(ctx.issueId).current;
      if (ctx.turns.busy(ctx.issueId)) {
        return "I am still working on this issue. Send `@agent /cancel` first, then `@agent /new`.";
      }
      ctx.sessions.rotate(ctx.issueId);
      if (previous) ctx.releaseApprovalSession?.(previous);
      return previous ? `Started a new session. Previous session \`${previous}\` archived.` : "Started a new session.";
    }
    case "cancel": {
      const n = ctx.turns.cancel(ctx.issueId);
      if (n === 0) return "Nothing is running on this issue.";
      return n === 1 ? "Cancelling the current request." : `Cancelling the current request and ${n - 1} queued.`;
    }
  }
}
