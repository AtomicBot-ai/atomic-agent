import type { SessionState } from "../session/session-state.js";
import {
  findCurrentMacroTurnStart,
  renderTurnForPrompt,
  type ConversationTurn,
  type RenderTurnOptions,
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
  // Start lines of `os.fs.read` calls still waiting for their result, in
  // call order (a batch may list several calls before their results), so a
  // read cut at render time can name the `offset` of the rest.
  let pendingReadStarts: (number | undefined)[] = [];
  for (let i = 0; i < packed.visibleTurns.length; i += 1) {
    const turn = packed.visibleTurns[i]!;
    const options: RenderTurnOptions = { inCurrentMacroTurn: i >= currentStart };
    if (turn.kind === "user" || turn.kind === "assistant_reply") {
      pendingReadStarts = [];
    } else if (turn.kind === "assistant_tool_call" && turn.tool === "os.fs.read") {
      pendingReadStarts.push(readStartLineOf(turn.args));
    } else if (turn.kind === "tool_result" && turn.tool === "os.fs.read") {
      const readStartLine = pendingReadStarts.shift();
      if (readStartLine !== undefined) options.readStartLine = readStartLine;
    }
    lines.push(renderTurnForPrompt(turn, options));
  }
  return lines.join("\n");
}

/**
 * First file line an `os.fs.read` call returns, mirroring the tool's own
 * argument handling: no numeric `offset` (or `0`) reads from line 1. A
 * negative offset counts from the end of a file whose length is not known
 * here, so it yields `undefined`.
 */
function readStartLineOf(args: Record<string, unknown>): number | undefined {
  const offset = args.offset;
  if (typeof offset !== "number" || !Number.isFinite(offset)) return 1;
  const whole = Math.trunc(offset);
  if (whole < 0) return undefined;
  return Math.max(1, whole);
}
