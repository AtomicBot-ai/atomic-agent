import { estimateTokens } from "../prompt/token-budget.js";

/**
 * A single entry in the chat transcript. We use the every-step layout:
 * every `assistant_tool_call` and `tool_result` is its own turn so the
 * model can observe the full action chain during multi-turn runs. A
 * macro-turn (one user message → 0..N tool steps → one reply) is a
 * contiguous slice of this list.
 */
export type ConversationTurn =
  | { kind: "user"; text: string; at: number }
  | {
      kind: "assistant_tool_call";
      tool: string;
      args: Record<string, unknown>;
      reasoning?: string;
      at: number;
    }
  | {
      kind: "tool_result";
      tool: string;
      status: "ok" | "error";
      summary: string;
      truncated?: boolean;
      at: number;
    }
  | {
      kind: "assistant_reply";
      text: string;
      /** Content of `<think>` blocks that preceded the final reply, if any. */
      reasoning?: string;
      at: number;
    };

export function userTurn(text: string, at = Date.now()): ConversationTurn {
  return { kind: "user", text, at };
}

export function assistantToolCallTurn(params: {
  tool: string;
  args: Record<string, unknown>;
  reasoning?: string;
  at?: number;
}): ConversationTurn {
  let turn: ConversationTurn = {
    kind: "assistant_tool_call",
    tool: params.tool,
    args: params.args,
    at: params.at ?? Date.now(),
  };
  if (params.reasoning !== undefined && params.reasoning.length > 0) {
    turn = { ...turn, reasoning: params.reasoning };
  }
  return turn;
}

export function toolResultTurn(params: {
  tool: string;
  status: "ok" | "error";
  summary: string;
  truncated?: boolean;
  at?: number;
}): ConversationTurn {
  const turn: ConversationTurn = {
    kind: "tool_result",
    tool: params.tool,
    status: params.status,
    summary: params.summary,
    at: params.at ?? Date.now(),
  };
  if (params.truncated) return { ...turn, truncated: true };
  return turn;
}

/**
 * Build an `assistant_reply` turn. The second argument is either the
 * legacy positional `at` timestamp or an options object with optional
 * `at` and `reasoning`. Keeping both shapes means existing callers (and
 * tests) that passed a bare number stay valid.
 */
export function assistantReplyTurn(
  text: string,
  atOrOptions: number | { at?: number; reasoning?: string } = {},
): ConversationTurn {
  const options =
    typeof atOrOptions === "number" ? { at: atOrOptions } : atOrOptions;
  const at = options.at ?? Date.now();
  let turn: ConversationTurn = { kind: "assistant_reply", text, at };
  if (options.reasoning !== undefined && options.reasoning.length > 0) {
    turn = { ...turn, reasoning: options.reasoning };
  }
  return turn;
}

/**
 * Upper bound on the number of characters of a `tool_result.summary` that
 * we are willing to paste back into `### conversation`. Tools like
 * `os.fs.read_document` and `os.fs.read` cap their own summary at the
 * read budget (`maxBytes`, up to 5MB), which — uncapped at render — would
 * dump the entire file into the prompt tail and keep it there on every
 * subsequent turn. The model still sees the full `summary` on the step
 * that produced it (up to this cap), and retains structured metadata on
 * `details`. Concrete value: ~1000 tokens, which covers 3-4 PDF pages or
 * a short code file and matches the `maxTailLines` budget most tools use.
 */
const TOOL_RESULT_RENDER_CAP_CHARS = 4000;

/**
 * Tools whose `tool_result.summary` is rendered **uncapped** into
 * `### conversation` while the result is "fresh" (still inside the
 * current macro-turn — i.e. no `assistant_reply` has been emitted since
 * the call). Once the macro-turn closes with an `assistant_reply`, these
 * results revert to the standard `TOOL_RESULT_RENDER_CAP_CHARS` cap so
 * the conversation history does not pay full token cost forever.
 *
 * The semantic: the model needs the full body **on the inference that
 * consumes the result**. After the agent has produced its reply for the
 * user, the body is no longer load-bearing — a compact tail is enough
 * for "did this happen?" recall.
 */
const TOOLS_FULL_BODY_WHEN_FRESH: ReadonlySet<string> = new Set([
  "os.http.request",
]);

/**
 * Cap applied to fresh-bypass tool results once they age out of the
 * current macro-turn. Matches the original `compressToolResult` default
 * (400 chars) so the historical "summary" footprint stays unchanged.
 */
const TOOL_RESULT_HISTORY_CAP_CHARS = 400;

export interface RenderTurnOptions {
  /**
   * `true` when this turn is part of the **current macro-turn** — i.e.
   * the slice of turns after the most recent `assistant_reply`. The
   * caller is responsible for computing this; defaults to `false` (safe
   * — applies the standard render cap).
   */
  inCurrentMacroTurn?: boolean;
}

/**
 * Render a single turn as a compact line for the prompt's `### conversation`
 * section. The format mirrors the one used by ChatML/Hermes-style models so
 * a small LLM can recognise the turn boundaries without a custom template.
 */
export function renderTurnForPrompt(
  turn: ConversationTurn,
  options: RenderTurnOptions = {},
): string {
  switch (turn.kind) {
    case "user":
      return `user: ${turn.text}`;
    case "assistant_tool_call": {
      const argsJson = JSON.stringify(turn.args);
      return `assistant_tool_call: ${turn.tool} ${argsJson}`;
    }
    case "tool_result": {
      const prefix = `tool_result[${turn.tool} ${turn.status}]`;
      const body = renderToolResultBody(turn, options);
      return `${prefix}: ${body}${turn.truncated ? " (truncated)" : ""}`;
    }
    case "assistant_reply":
      return `assistant: ${turn.text}`;
  }
}

function renderToolResultBody(
  turn: Extract<ConversationTurn, { kind: "tool_result" }>,
  options: RenderTurnOptions,
): string {
  if (TOOLS_FULL_BODY_WHEN_FRESH.has(turn.tool)) {
    if (options.inCurrentMacroTurn === true) return turn.summary;
    return capSummary(turn.summary, TOOL_RESULT_HISTORY_CAP_CHARS);
  }
  return capSummary(turn.summary, TOOL_RESULT_RENDER_CAP_CHARS);
}

function capSummary(summary: string, capChars: number): string {
  if (summary.length <= capChars) return summary;
  const keep = Math.max(1, capChars - 40);
  return `${summary.slice(0, keep)}\n… [rendering-truncated ${summary.length - keep} chars]`;
}

/**
 * Find the index of the first turn that belongs to the current
 * macro-turn — i.e. the slice of turns strictly after the most recent
 * `assistant_reply`. Returns `0` when no reply has been emitted yet
 * (everything is part of the current macro-turn).
 */
export function findCurrentMacroTurnStart(
  turns: readonly ConversationTurn[],
): number {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i]?.kind === "assistant_reply") return i + 1;
  }
  return 0;
}

/**
 * Outcome of `packConversation`. `droppedSummary`, when present, is a
 * single-line deterministic recap that callers are expected to render
 * above the visible tail so the model can tell something was compressed.
 */
export interface PackedConversation {
  visibleTurns: ConversationTurn[];
  droppedSummary: string | null;
  droppedCount: number;
}

/**
 * Token budget we always carve out for the summary line when truncation
 * kicks in. The line itself is O(1) in length regardless of how many
 * turns got dropped, so a small fixed reserve is safe.
 */
const SUMMARY_TOKEN_RESERVE = 40;

/**
 * Pick the tail of the turn list that fits within `maxTokens` and return
 * a deterministic one-line summary for the dropped prefix. Older turns
 * go first, but the last `user` turn is always visible so the model
 * never loses the current request. Summary format matches:
 * `summary: N older turns dropped (K user, L tool calls, M replies; first at ISO, last at ISO)`.
 */
export function packConversation(
  turns: readonly ConversationTurn[],
  maxTokens: number,
): PackedConversation {
  if (turns.length === 0) {
    return { visibleTurns: [], droppedSummary: null, droppedCount: 0 };
  }
  if (maxTokens <= 0) {
    return {
      visibleTurns: [],
      droppedSummary: renderDroppedSummary(turns),
      droppedCount: turns.length,
    };
  }

  // Estimate sizes with the same `inCurrentMacroTurn` flag the renderer
  // will apply downstream — otherwise tools that bypass the cap when
  // fresh (e.g. `os.http.request`) get under-estimated and the packed
  // section overshoots `maxTokens`.
  const currentStart = findCurrentMacroTurnStart(turns);
  const rendered = turns.map((turn, i) =>
    renderTurnForPrompt(turn, { inCurrentMacroTurn: i >= currentStart }),
  );
  const tokenCosts = rendered.map((line) => estimateTokens(line) + 1);
  const total = tokenCosts.reduce((a, b) => a + b, 0);
  if (total <= maxTokens) {
    return { visibleTurns: [...turns], droppedSummary: null, droppedCount: 0 };
  }

  // Truncation is inevitable — reserve tokens for the summary line so the
  // final prompt section still fits within `maxTokens`.
  const budget = Math.max(1, maxTokens - SUMMARY_TOKEN_RESERVE);
  let acc = 0;
  let startIndex = turns.length;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const cost = tokenCosts[i] ?? 0;
    if (acc + cost > budget) break;
    acc += cost;
    startIndex = i;
  }

  const lastUserIndex = findLastUserIndex(turns);
  if (lastUserIndex !== -1 && lastUserIndex < startIndex) {
    startIndex = lastUserIndex;
  }

  const droppedSlice = turns.slice(0, startIndex);
  const visibleTurns = turns.slice(startIndex);

  if (droppedSlice.length === 0) {
    return { visibleTurns, droppedSummary: null, droppedCount: 0 };
  }

  return {
    visibleTurns,
    droppedSummary: renderDroppedSummary(droppedSlice),
    droppedCount: droppedSlice.length,
  };
}

/**
 * Legacy thin wrapper kept so existing callers/tests that only care about
 * the trimmed tail still work. New code should prefer `packConversation`
 * which also exposes the `summary:` line.
 */
export function trimTurnsToTokens(
  turns: readonly ConversationTurn[],
  maxTokens: number,
): { turns: ConversationTurn[]; truncated: boolean } {
  const packed = packConversation(turns, maxTokens);
  return {
    turns: packed.visibleTurns,
    truncated: packed.droppedCount > 0,
  };
}

function renderDroppedSummary(turns: readonly ConversationTurn[]): string {
  let user = 0;
  let toolCalls = 0;
  let replies = 0;
  for (const t of turns) {
    if (t.kind === "user") user += 1;
    else if (t.kind === "assistant_tool_call") toolCalls += 1;
    else if (t.kind === "assistant_reply") replies += 1;
  }
  const first = turns[0]?.at ?? 0;
  const last = turns[turns.length - 1]?.at ?? first;
  const firstIso = new Date(first).toISOString();
  const lastIso = new Date(last).toISOString();
  return `summary: ${turns.length} older turns dropped (${user} user, ${toolCalls} tool calls, ${replies} replies; first at ${firstIso}, last at ${lastIso})`;
}

function findLastUserIndex(turns: readonly ConversationTurn[]): number {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i]?.kind === "user") return i;
  }
  return -1;
}

/**
 * Pure append helper so reducers can build a new turn list without
 * mutating the session state.
 */
export function appendTurn(
  turns: readonly ConversationTurn[],
  next: ConversationTurn,
): ConversationTurn[] {
  return [...turns, next];
}
