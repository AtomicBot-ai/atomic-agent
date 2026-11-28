import type { RewindScope } from "../../runtime/session-rewind-service.js";
import type { RewindPoint } from "../../session/session-rewind.js";
import type { RewindChoiceFacts, RewindChoiceState } from "../tui-state.js";

/**
 * The "what to take back" step of `/rewind` (ATO-2467), like Claude
 * Code's "Restore code and conversation / Restore conversation / Restore
 * code". Pure: the orchestrator works out the facts and does the rewind.
 *
 * The file choices are offered only when the agent's file tools changed
 * something after the point that can still be put back; otherwise the
 * only choice is the chat, and the box says why.
 */

/** Opened on a picked point; no choices until its files are checked. */
export function requestRewindChoice(point: RewindPoint): RewindChoiceState {
  return { point, facts: null, options: [], cursor: 0 };
}

/** The checked facts for the point still on screen; any other answer is stale. */
export function readyRewindChoice(
  choice: RewindChoiceState,
  turnIndex: number,
  facts: RewindChoiceFacts,
): RewindChoiceState {
  if (choice.point.turnIndex !== turnIndex) return choice;
  return { ...choice, facts, options: rewindScopes(facts), cursor: 0 };
}

/** Move or set the highlight, clamped to the choices offered. */
export function moveRewindChoice(choice: RewindChoiceState, row: number): RewindChoiceState {
  const max = Math.max(0, choice.options.length - 1);
  return { ...choice, cursor: Math.min(max, Math.max(0, row)) };
}

/** The choices for these facts, the one taking back the most first. */
export function rewindScopes(facts: RewindChoiceFacts): RewindScope[] {
  return facts.fileCount > 0 ? ["all", "conversation", "files"] : ["conversation"];
}

/** A choice's row label. */
export function rewindScopeLabel(scope: RewindScope): string {
  switch (scope) {
    case "all":
      return "Chat and files";
    case "conversation":
      return "Chat only";
    case "files":
      return "Files only";
  }
}

/** A choice's one-line explanation. */
export function rewindScopeHint(scope: RewindScope, fileCount: number): string {
  const files = fileCount === 1 ? "1 file" : `${fileCount} files`;
  switch (scope) {
    case "all":
      return `remove this message and everything after it, and put back ${files}`;
    case "conversation":
      return "remove this message and everything after it; files stay as they are";
    case "files":
      return `put back ${files}; the chat stays as it is`;
  }
}
