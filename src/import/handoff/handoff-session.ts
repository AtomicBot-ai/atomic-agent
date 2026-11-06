import { randomUUID } from "node:crypto";

import {
  toolResultTurn,
  type ConversationTurn,
} from "../../session/conversation-turn.js";
import { macroTurnStartsFromTurns } from "../../session/macro-turn-starts.js";
import type { SessionState } from "../../session/session-state.js";
import { SESSION_TITLE_METADATA_KEY } from "../../session/session-title.js";
import {
  HANDOFF_AGENT_LABEL,
  type HandoffAgent,
  type HandoffTranscript,
} from "./handoff-source.js";

/** Metadata keys a handed-off session carries. */
export const HANDOFF_FROM_METADATA_KEY = "handoffFrom";
export const HANDOFF_SOURCE_SESSION_METADATA_KEY = "handoffSourceSessionId";

const IMPORT_MARKER_KEYS = new Set([
  "importedFrom",
  "claudeCodeSessionId",
  "codexSessionId",
]);

export interface BuildHandoffInput {
  transcript: HandoffTranscript;
  /** Folder the work continues in; the transcript's cwd when omitted. */
  workingDir?: string;
  /** Extra words from the operator, appended to the continuation prompt. */
  note?: string;
  now?: number;
  newId?: () => string;
}

export interface HandoffSession {
  /** A new native session, ready for `SessionStore.save`. */
  session: SessionState;
  /** The first message to send in it. */
  prompt: string;
  /** How many trailing tool calls had no result and were closed. */
  closedCalls: number;
}

/**
 * Turn another agent's transcript into a native session that continues
 * it. It is a NEW session (fresh `s-` id), not the import row: an
 * earlier `atag import` of the same transcript stays as it was, and
 * handing the same session off twice gives two independent threads.
 *
 * A transcript cut off by a usage limit often ends on a tool call whose
 * result never came back. Left open, the next request would carry a
 * call with no answer, so each trailing unanswered call gets an error
 * result that says why.
 */
export function buildHandoffSession(input: BuildHandoffInput): HandoffSession {
  const { transcript } = input;
  const agent = transcript.candidate.agent;
  const label = HANDOFF_AGENT_LABEL[agent];
  const now = input.now ?? Date.now();
  const id = input.newId ? input.newId() : `s-${randomUUID()}`;
  const workingDir = input.workingDir ?? transcript.mapped.workingDir;

  const { turns, closed } = closeDanglingCalls(transcript.mapped.turns, label, now);

  // The import markers would file this thread under "imported"; it is
  // ours now. Where it came from rides on the handoff keys instead.
  const restMetadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(transcript.mapped.metadata ?? {})) {
    if (IMPORT_MARKER_KEYS.has(key)) continue;
    restMetadata[key] = value;
  }
  const baseTitle = transcript.candidate.title ?? `${label} session`;

  const session: SessionState = {
    ...transcript.mapped,
    id,
    workingDir,
    status: "completed",
    turns,
    macroTurnStarts: macroTurnStartsFromTurns(turns),
    updatedAt: now,
    lastError: null,
    metadata: {
      ...restMetadata,
      [SESSION_TITLE_METADATA_KEY]: `${baseTitle} (from ${label})`,
      [HANDOFF_FROM_METADATA_KEY]: agent,
      [HANDOFF_SOURCE_SESSION_METADATA_KEY]: transcript.candidate.id,
    },
  };

  return {
    session,
    prompt: handoffPrompt(agent, workingDir, input.note),
    closedCalls: closed,
  };
}

/** The message that asks our agent to pick the work up. */
export function handoffPrompt(
  agent: HandoffAgent,
  workingDir: string,
  note?: string,
): string {
  const label = HANDOFF_AGENT_LABEL[agent];
  const lines = [
    `You are taking over this task from ${label}, which stopped before it was done (most likely it ran out of its usage limit).`,
    `The conversation above is its session. Re-read my last request and the last steps it took, check the current state of the files in ${workingDir} before you change anything, then continue the work from where it stopped. Do not redo steps that are already done.`,
  ];
  const extra = note?.trim();
  if (extra) lines.push(`Also: ${extra}`);
  return lines.join("\n\n");
}

function closeDanglingCalls(
  turns: readonly ConversationTurn[],
  label: string,
  at: number,
): { turns: ConversationTurn[]; closed: number } {
  // Calls after the last result/reply/user turn are the unanswered tail.
  let tail = turns.length;
  while (tail > 0 && turns[tail - 1]!.kind === "assistant_tool_call") tail -= 1;
  const open = turns.slice(tail);
  if (open.length === 0) return { turns: [...turns], closed: 0 };
  const results = open.map((call) =>
    toolResultTurn({
      tool: call.kind === "assistant_tool_call" ? call.tool : "unknown",
      status: "error",
      summary: `No result: ${label} stopped before this call returned. Check whether it ran before relying on it.`,
      at,
    }),
  );
  return { turns: [...turns, ...results], closed: open.length };
}
