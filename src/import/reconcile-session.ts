import type { ConversationTurn } from "../session/conversation-turn.js";
import type { SessionState } from "../session/session-state.js";

export interface ReconcileImportedSessionArgs {
  /** What the destination store already holds under `mapped.id`, if anything. */
  existing: SessionState | null;
  /** The freshly mapped source session. */
  mapped: SessionState;
  /** When false, decide without writing. */
  execute: boolean;
  /** Replace a diverged destination instead of flagging a conflict. */
  overwrite: boolean;
  save(state: SessionState): void;
}

export interface ReconcileImportedSessionResult {
  status: "migrated" | "skipped" | "conflict";
  reason?: string;
}

/**
 * The one rule every importer applies when a mapped session meets the
 * destination store. Shared so a re-import behaves the same whichever
 * agent the session came from:
 *
 *  - nothing there                      → save, `migrated`.
 *  - transcripts identical              → `skipped` ("already matches").
 *  - same source and the stored turns are a strict prefix of the mapped
 *    ones (the source session simply grew since the last import) → save,
 *    `migrated` ("updated (+N turns)"). Destination-only metadata keys
 *    (an `llm` stamp, a title the operator set) survive the update.
 *  - anything else — turns the operator appended locally, an edited
 *    source, a different origin under the same id → `conflict` unless
 *    `overwrite`, which replaces the destination outright.
 *
 * Turns are compared structurally, one by one, so a local continuation
 * (which makes the stored transcript longer than, or divergent from,
 * the source) can never be mistaken for growth at the source.
 */
export function reconcileImportedSession(
  args: ReconcileImportedSessionArgs,
): ReconcileImportedSessionResult {
  const { existing, mapped, execute, overwrite, save } = args;
  if (!existing) {
    if (execute) save(mapped);
    return { status: "migrated" };
  }
  if (turnsEqual(existing.turns, mapped.turns)) {
    return { status: "skipped", reason: "already matches" };
  }
  if (
    sameSource(existing, mapped) &&
    isStrictPrefix(existing.turns, mapped.turns)
  ) {
    if (execute) {
      save({
        ...mapped,
        metadata: { ...existing.metadata, ...mapped.metadata },
      });
    }
    const added = mapped.turns.length - existing.turns.length;
    return { status: "migrated", reason: `updated (+${added} turns)` };
  }
  if (!overwrite) {
    return {
      status: "conflict",
      reason: "destination differs; use --overwrite",
    };
  }
  if (execute) save(mapped);
  return { status: "migrated", reason: "overwritten" };
}

function sameSource(a: SessionState, b: SessionState): boolean {
  const from = a.metadata.importedFrom;
  return typeof from === "string" && from === b.metadata.importedFrom;
}

function turnsEqual(
  a: readonly ConversationTurn[],
  b: readonly ConversationTurn[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((turn, index) => sameTurn(turn, b[index]!));
}

/** `a` is a proper leading slice of `b` (shorter, and equal turn by turn). */
function isStrictPrefix(
  a: readonly ConversationTurn[],
  b: readonly ConversationTurn[],
): boolean {
  if (a.length >= b.length) return false;
  return a.every((turn, index) => sameTurn(turn, b[index]!));
}

function sameTurn(a: ConversationTurn, b: ConversationTurn): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
