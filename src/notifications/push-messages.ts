import type { PushMessage } from "./ntfy-client.js";

/**
 * What a phone push says, per event (ATO-1129). Short on purpose: a
 * title and the first ~200 characters of the agent's own answer — never
 * tool output, file contents or a command line, which is where secrets
 * live. `sendPush` masks and clips again on the way out.
 */

export type PushTurnOutcome = "completed" | "failed" | "cancelled";

function took(durationMs: number): string {
  const s = Math.max(0, Math.round(durationMs / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

/** A chat turn ended (the TUI's `tui.notify` moment). */
export function formatTurnPush(p: {
  outcome: PushTurnOutcome;
  /** The turn's last assistant message, if it left one. */
  reply: string | null;
  /** The failure reason, for a failed turn. */
  reason: string;
  stepCount: number;
  durationMs: number;
  workingDirName?: string | undefined;
}): PushMessage {
  const where = p.workingDirName ? ` · ${p.workingDirName}` : "";
  const facts = `${p.stepCount} step${p.stepCount === 1 ? "" : "s"} · ${took(p.durationMs)}${where}`;
  if (p.outcome === "failed") {
    return {
      title: "Atomic Agent: turn failed",
      body: `${p.reason} · ${facts}`,
      tags: ["x"],
      priority: 4,
    };
  }
  if (p.outcome === "cancelled") {
    return { title: "Atomic Agent: turn stopped", body: facts, tags: ["stop_sign"] };
  }
  const reply = (p.reply ?? "").trim();
  return {
    title: "Atomic Agent: turn done",
    body: reply || facts,
    tags: ["white_check_mark"],
  };
}

/**
 * The agent is waiting on an approval. Names the tool only: the preview
 * (a command, a diff, a URL with a key in it) stays on the machine.
 */
export function formatApprovalPush(tool: string): PushMessage {
  return {
    title: "Atomic Agent needs your approval",
    body: `Waiting on ${tool}. Open Atomic Agent to answer.`,
    tags: ["raised_hand"],
    priority: 4,
  };
}

/** A durable task (`task create --notify push`, `overnight`) reached an end. */
export function formatTaskPush(p: {
  status: "completed" | "failed" | "blocked";
  userMessage: string;
  replyText: string | null;
  errorMessage: string | null;
  durationMs: number | null;
}): PushMessage {
  const job = p.userMessage.trim().replace(/\s+/g, " ").slice(0, 60);
  const when = p.durationMs !== null ? ` (${took(p.durationMs)})` : "";
  if (p.status === "completed") {
    return {
      title: `Task done${when}: ${job}`,
      body: (p.replyText ?? "").trim() || "Finished. Open Atomic Agent for the result.",
      tags: ["white_check_mark"],
    };
  }
  return {
    title: `Task ${p.status === "failed" ? "failed" : "stopped"}${when}: ${job}`,
    body: (p.errorMessage ?? "").trim() || "Open Atomic Agent to see why.",
    tags: [p.status === "failed" ? "x" : "warning"],
    priority: 4,
  };
}

/** A background model download ended: the same words as the other channels. */
export function formatDownloadPush(text: string): PushMessage {
  const [first = "", ...rest] = text.split("\n");
  return { title: first, body: rest.join(" ") || first };
}
