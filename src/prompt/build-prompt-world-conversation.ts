import type { SessionState } from "../session/session-state.js";
import {
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
  for (const turn of packed.visibleTurns) {
    lines.push(renderTurnForPrompt(turn));
  }
  return lines.join("\n");
}
