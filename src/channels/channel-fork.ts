import type { AgentRuntime } from "../runtime/runtime-contract.js";
import { planFork, type ForkRefusal } from "../session/session-fork.js";
import { countQuestions } from "../session/session-previous-replies.js";
import type { SessionState } from "../session/session-state.js";

/**
 * `/fork` in a messenger channel (ATO-2235): copy the chat's session
 * into a new one, the same copy the desktop's Fork makes
 * (`POST /api/sessions/{id}/fork`, ATO-1058). Plain `/fork` is taken at
 * the chat's last question so the whole conversation comes along;
 * `/fork <n>` (ATO-2456) is taken at question n, counted from the
 * first, and keeps that question and its answer.
 *
 * Only the session state is copied: the working folder is not cloned
 * and the source's compaction summary is carried as it is, never
 * re-generated. The source session is not touched; the caller saves the
 * fork and decides where it lives (a new Telegram topic, a new Slack or
 * Discord thread, or this chat with the source kept in its history).
 *
 * Precedent: OpenClaw v2026.11.10 conversation-fork (Telegram topic per
 * fork, same copy as its UI fork); Claude Code `/rewind` lists the
 * earlier messages to pick a point from, the list `/fork <n>` shows when
 * the number is missing or out of range.
 */

export type ChannelForkResult =
  | { ok: true; source: SessionState; state: SessionState; title: string }
  | { ok: false; message: string };

export interface ChannelForkOptions {
  /** The text after the verb: empty for the last question, else a number. */
  at?: string;
  /** How this channel spells the command, for the usage line ("/fork", "!fork"). */
  command?: string;
}

const REFUSALS: Record<ForkRefusal, string> = {
  turn_in_progress: "A turn is running here. Wait for it to finish (or cancel it), then fork.",
  point_compacted: "This chat cannot be forked from there: that message is inside the compacted summary.",
  point_mismatch: "Nothing to fork yet: send a message first.",
};

/** How many recent questions the usage reply lists. */
const LISTED_QUESTIONS = 10;
const PREVIEW_CHARS = 60;

export function planChannelFork(
  runtime: Pick<AgentRuntime, "sessionStore" | "turnController">,
  sourceId: string | null,
  options: ChannelForkOptions = {},
): ChannelForkResult {
  if (!sourceId) return { ok: false, message: "No session here yet: send a message first." };
  const source = runtime.sessionStore.load(sourceId);
  if (!source) return { ok: false, message: `Session ${sourceId} is missing, nothing to fork.` };
  if (runtime.turnController.isBusy(source.id)) {
    return { ok: false, message: REFUSALS.turn_in_progress };
  }
  const questions = countQuestions(source.turns);
  if (questions === 0) return { ok: false, message: REFUSALS.point_mismatch };
  const at = parseForkPoint(options.at, questions);
  if (at === null) {
    return { ok: false, message: forkUsage(source, questions, options.command ?? "/fork") };
  }
  const plan = planFork(source, { priorQuestions: at - 1 });
  if (!plan.ok) return { ok: false, message: REFUSALS[plan.code] };
  return { ok: true, source, state: plan.state, title: plan.title };
}

/**
 * The 1-based question to fork at: the last one when `raw` is empty,
 * `null` when it is not a whole number between 1 and `questions`.
 */
export function parseForkPoint(raw: string | undefined, questions: number): number | null {
  const text = (raw ?? "").trim();
  if (text.length === 0) return questions;
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 && n <= questions ? n : null;
}

/** The reply to a bad `/fork <n>`: the valid range and the latest questions, numbered. */
export function forkUsage(source: SessionState, questions: number, command: string): string {
  const texts = source.turns
    .filter((turn) => turn.kind === "user" && turn.steered !== true)
    .map((turn) => (turn.kind === "user" ? preview(turn.text) : ""));
  const first = Math.max(0, texts.length - LISTED_QUESTIONS);
  const lines = texts.slice(first).map((text, i) => `${first + i + 1}. ${text}`);
  const range =
    questions === 1
      ? `This chat has 1 question: ${command} 1 (or just ${command}) forks it.`
      : `This chat has ${questions} questions: ${command} 1 forks from the first, ${command} ${questions} (or just ${command}) from the latest.`;
  return [range, first > 0 ? "Latest questions:" : "Questions:", ...lines].join("\n");
}

/** One line of the question, without the `[from]` sender line channels prepend. */
function preview(text: string): string {
  const body = text.replace(/^\[from\][^\n]*\n/, "").replace(/\s+/g, " ").trim();
  if (body.length === 0) return "(no text)";
  return body.length > PREVIEW_CHARS ? `${body.slice(0, PREVIEW_CHARS - 1).trimEnd()}…` : body;
}
