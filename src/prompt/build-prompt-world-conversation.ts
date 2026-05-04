import type { SessionState } from "../session/session-state.js";
import {
  findCurrentMacroTurnStart,
  renderTurnForPrompt,
  type ConversationTurn,
} from "../session/conversation-turn.js";

export function renderWorldSnapshotSection(session: SessionState): string {
  const snap = session.worldSnapshot;
  if (!snap || snap.kind === "none") return "(no world snapshot available)";
  return [`kind: ${snap.kind}`, `digest: ${snap.digest}`, ``, snap.text].join(
    "\n",
  );
}

/**
 * Render the packed conversation section. When `packConversation` folded
 * older turns into a summary, that summary is emitted as the first line
 * so the model can tell the transcript was compressed.
 */
export function renderPackedConversation(packed: {
  visibleTurns: readonly ConversationTurn[];
  droppedSummary: string | null;
}): string {
  if (packed.visibleTurns.length === 0 && packed.droppedSummary === null) {
    return "(no messages yet)";
  }
  const lines: string[] = [];
  if (packed.droppedSummary) lines.push(packed.droppedSummary);
  // Index of the first turn that belongs to the current (un-replied) macro
  // turn. Tools listed in `TOOLS_FULL_BODY_WHEN_FRESH` (see conversation-turn.ts)
  // render their full payload only while inside this slice; older
  // tool_results from already-replied macro-turns are capped to a small
  // history footprint so the prompt does not pay full token cost on
  // every subsequent step.
  const currentStart = findCurrentMacroTurnStart(packed.visibleTurns);
  for (let i = 0; i < packed.visibleTurns.length; i += 1) {
    const turn = packed.visibleTurns[i]!;
    lines.push(
      renderTurnForPrompt(turn, { inCurrentMacroTurn: i >= currentStart }),
    );
  }
  return lines.join("\n");
}
