import type { PromptTurn } from "../llm/provider/completion-types.js";
import type { SessionState } from "../session/session-state.js";
import {
  findCurrentMacroTurnStart,
  readRepeatRefs,
  readRepeatStub,
  readStartLineOf,
  renderToolResultBody,
  renderTurnForPrompt,
  type ConversationTurn,
  type RenderTurnOptions,
} from "../session/conversation-turn.js";
import { BROWSER_PAGE_SOURCE, frameUntrustedText } from "../tools/untrusted-tool-output.js";
import { estimateTokens, truncateToTokens } from "./token-budget.js";

/** Source named in the framing line above a browser page (ATO-1378). */
export const WORLD_SNAPSHOT_SOURCE = BROWSER_PAGE_SOURCE;

/** The `### world` section, the page whole. */
export function renderWorldSnapshotSection(session: SessionState): string {
  return fitWorldSnapshotSection(session).text;
}

/**
 * The `### world` section within `maxTokens`. A page too long for it is
 * cut inside the fence, so the closing marker of the untrusted block
 * always stays (a cut fence would leave the rest of the prompt looking
 * like page text). `truncated` says whether the page was cut.
 */
export function fitWorldSnapshotSection(
  session: SessionState,
  maxTokens?: number,
): { text: string; truncated: boolean } {
  const snap = session.worldSnapshot;
  if (!snap || snap.kind === "none") return { text: "(no world snapshot available)", truncated: false };
  // The snapshot is the page's own text: fake chat-template tokens on a
  // web page must not reach the model as control markup, and the page is
  // framed as data in a nonce-fenced block, like a fetched page
  // (ATO-1378). The nonce is stable for the same text, so re-rendering
  // the same page keeps the prompt's bytes.
  const render = (text: string): string =>
    [
      `kind: ${snap.kind}`,
      `digest: ${snap.digest}`,
      ``,
      frameUntrustedText(text, WORLD_SNAPSHOT_SOURCE),
    ].join("\n");
  const full = render(snap.text);
  if (maxTokens === undefined || estimateTokens(full) <= maxTokens) return { text: full, truncated: false };
  let budget = maxTokens - (estimateTokens(full) - estimateTokens(snap.text));
  for (let tries = 0; tries < 8 && budget > 0; tries += 1) {
    const cut = render(truncateToTokens(snap.text, budget));
    const over = estimateTokens(cut) - maxTokens;
    if (over <= 0) return { text: cut, truncated: true };
    budget -= over;
  }
  return { text: render("… [truncated]"), truncated: true };
}

type PackedTurns = {
  visibleTurns: readonly ConversationTurn[];
  droppedSummary: string | null;
};

/**
 * Render the packed conversation section. When `packConversation` folded
 * older turns into a summary, that summary is emitted as the first line
 * so the model can tell the transcript was compressed.
 */
export function renderPackedConversation(packed: PackedTurns): string {
  if (packed.visibleTurns.length === 0 && packed.droppedSummary === null) {
    return "(no messages yet)";
  }
  const lines: string[] = [];
  if (packed.droppedSummary) lines.push(packed.droppedSummary);
  for (const [turn, options] of packedTurnRenderOptions(packed)) {
    lines.push(renderTurnForPrompt(turn, options));
  }
  return lines.join("\n");
}

/**
 * The same packed conversation as structure, for a provider that lays
 * history out as real chat messages. Each row carries what its text line
 * carries — a tool-result body capped by the same `RenderTurnOptions` the
 * text form applied, a reply with its attachment note — so the two forms
 * describe one transcript.
 */
export function packedConversationTurns(packed: PackedTurns): PromptTurn[] {
  const out: PromptTurn[] = [];
  for (const [turn, options] of packedTurnRenderOptions(packed)) {
    switch (turn.kind) {
      case "user":
        out.push({ kind: "user", text: turn.text });
        break;
      case "assistant_tool_call":
        out.push({
          kind: "assistant_tool_call",
          tool: turn.tool,
          args: turn.args,
          // Only the current macro-turn's reasoning goes back: the model
          // is still working on that request and its templates drop the
          // thinking of answered turns anyway (ATO-887).
          ...(options.inCurrentMacroTurn === true &&
          turn.reasoning !== undefined &&
          turn.reasoning.length > 0
            ? { reasoning: turn.reasoning }
            : {}),
        });
        break;
      case "tool_result":
        out.push({
          kind: "tool_result",
          tool: turn.tool,
          status: turn.status,
          body: renderToolResultBody(turn, options),
          // A pointer is whole as it stands; the read it points at carries
          // the mark, as on the flat line.
          truncated:
            turn.truncated === true && readRepeatStub(turn, options) === null,
        });
        break;
      case "assistant_reply":
        out.push({
          kind: "assistant_reply",
          text:
            turn.attachments !== undefined && turn.attachments.length > 0
              ? `${turn.text} (attached: ${turn.attachments.join(", ")})`
              : turn.text,
        });
        break;
    }
  }
  return out;
}

/**
 * Every visible turn paired with the render options the text form uses
 * for it. One walk for both renderers, so a cap decided here (fresh
 * `os.http.request` bodies, `os.fs.read` paging hints) cannot differ
 * between the flat and the structured prompt.
 */
function* packedTurnRenderOptions(
  packed: PackedTurns,
): Generator<[ConversationTurn, RenderTurnOptions]> {
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
  // A read that repeats one still in this prompt renders as a pointer to
  // it. Found on the visible turns only, so a pointer can never name a
  // read the packer cut away — that row renders in full instead.
  const readRepeats = readRepeatRefs(packed.visibleTurns);
  for (let i = 0; i < packed.visibleTurns.length; i += 1) {
    const turn = packed.visibleTurns[i]!;
    const options: RenderTurnOptions = { inCurrentMacroTurn: i >= currentStart };
    const readRepeat = readRepeats[i];
    if (readRepeat !== undefined) options.readRepeat = readRepeat;
    if (turn.kind === "user" || turn.kind === "assistant_reply") {
      pendingReadStarts = [];
    } else if (turn.kind === "assistant_tool_call" && turn.tool === "os.fs.read") {
      pendingReadStarts.push(readStartLineOf(turn.args));
    } else if (turn.kind === "tool_result" && turn.tool === "os.fs.read") {
      const readStartLine = pendingReadStarts.shift();
      if (readStartLine !== undefined) options.readStartLine = readStartLine;
    }
    yield [turn, options];
  }
}
