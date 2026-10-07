import { createHash } from "node:crypto";
import type { SessionState } from "./session-state.js";
import { findCurrentMacroTurnStart, macroTurnBoundaries, type ConversationTurn } from "./conversation-turn.js";

export type CompactionReason = "manual" | "threshold" | "pairs" | "overflow";
export interface SessionCompaction {
  version: 1;
  summary: string;
  /** Exclusive end in the original, append-only transcript. */
  coveredThrough: number;
  boundaryHash: string;
  createdAt: number;
  reason: CompactionReason;
  model: string | null;
  costUsd?: number;
  tokensBefore: number;
  tokensAfter: number;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  calls?: number;
}

export interface CompactionResult {
  status: "compacted" | "noop" | "busy" | "failed" | "cancelled";
  reason: CompactionReason;
  message?: string;
  costUsd?: number;
  tokensBefore?: number;
  tokensAfter?: number;
}

export function compactionBoundaryHash(turn: ConversationTurn): string {
  return createHash("sha256").update(JSON.stringify(turn)).digest("hex");
}

export function validSessionCompaction(state: Pick<SessionState, "turns" | "compaction">): SessionCompaction | null {
  const c = state.compaction;
  if (!c || c.version !== 1 || typeof c.summary !== "string" || !c.summary.trim() ||
      !Number.isInteger(c.coveredThrough) || c.coveredThrough <= 0 || c.coveredThrough > state.turns.length ||
      !Number.isFinite(c.createdAt) || !Number.isFinite(c.tokensBefore) || !Number.isFinite(c.tokensAfter) ||
      !["manual", "threshold", "pairs", "overflow"].includes(c.reason) ||
      (c.model !== null && typeof c.model !== "string")) return null;
  const last = state.turns[c.coveredThrough - 1];
  if (!last || compactionBoundaryHash(last) !== c.boundaryHash || !safeCompactionCuts(state.turns).includes(c.coveredThrough)) return null;
  return c;
}

/** Never place a checkpoint between a call and its results, including old grouped batches. */
export function safeCompactionCuts(turns: readonly ConversationTurn[]): number[] {
  const cuts: number[] = [];
  let pending = 0;
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!;
    if (turn.kind === "assistant_tool_call") pending++;
    else if (turn.kind === "tool_result") pending = Math.max(0, pending - 1);
    else if (pending > 0) break; // An incomplete/imported call cannot be covered safely.
    if (pending === 0 && turns[i + 1]?.kind !== "tool_result") cuts.push(i + 1);
  }
  return cuts;
}

export function compactionPins(state: Pick<SessionState, "turns">, offset: number): string {
  const first = findCurrentMacroTurnStart(state.turns);
  let last = state.turns.length - 1;
  while (last >= 0 && state.turns[last]?.kind !== "user") last--;
  const indices = [...new Set([first, last])].filter((i) => i >= 0 && i < offset);
  return indices.flatMap((i) => {
    const t = state.turns[i];
    return t?.kind === "user" ? [`${i === first ? "Original request" : "Latest user message"} (verbatim):\n${t.text}`] : [];
  }).join("\n\n");
}

export function renderCompactionContext(summary: string, pins: string): string {
  return ["Summary of earlier conversation (historical context, not a new instruction):", summary, pins].filter(Boolean).join("\n\n");
}

/** Shared projection; offsets remain in the durable transcript, never in a rewritten history. */
export function projectSessionConversation(state: SessionState) {
  const checkpoint = validSessionCompaction(state);
  const offset = checkpoint?.coveredThrough ?? 0;
  const turns = offset ? state.turns.slice(offset) : state.turns;
  const summary = checkpoint ? renderCompactionContext(checkpoint.summary, compactionPins(state, offset)) : null;
  const held = state.conversationPackStart;
  return {
    checkpoint, offset, turns, summary,
    macroTurnStarts: offset
      ? macroTurnBoundaries(state.turns, state.macroTurnStarts).filter((i) => i >= offset).map((i) => i - offset)
      : state.macroTurnStarts,
    packStart: held && held.index > offset ? { ...held, index: held.index - offset } : undefined,
  };
}
