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
  | { kind: "assistant_reply"; text: string; at: number };

export function userTurn(text: string, at = Date.now()): ConversationTurn {
  return { kind: "user", text, at };
}

export function assistantToolCallTurn(params: {
  tool: string;
  args: Record<string, unknown>;
  reasoning?: string;
  at?: number;
}): ConversationTurn {
  const turn: ConversationTurn = {
    kind: "assistant_tool_call",
    tool: params.tool,
    args: params.args,
    at: params.at ?? Date.now(),
  };
  if (params.reasoning !== undefined && params.reasoning.length > 0) {
    return { ...turn, reasoning: params.reasoning };
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

export function assistantReplyTurn(text: string, at = Date.now()): ConversationTurn {
  return { kind: "assistant_reply", text, at };
}

/**
 * Render a single turn as a compact line for the prompt's `### conversation`
 * section. The format mirrors the one used by ChatML/Hermes-style models so
 * a small LLM can recognise the turn boundaries without a custom template.
 */
export function renderTurnForPrompt(turn: ConversationTurn): string {
  switch (turn.kind) {
    case "user":
      return `user: ${turn.text}`;
    case "assistant_tool_call": {
      const argsJson = JSON.stringify(turn.args);
      return `assistant_tool_call: ${turn.tool} ${argsJson}`;
    }
    case "tool_result": {
      const prefix = `tool_result[${turn.tool} ${turn.status}]`;
      return `${prefix}: ${turn.summary}${turn.truncated ? " (truncated)" : ""}`;
    }
    case "assistant_reply":
      return `assistant: ${turn.text}`;
  }
}

/**
 * Pick the tail of the turn list that fits within `maxTokens`. Older turns
 * are dropped first, but we always keep at least the last `user` turn so
 * the model never loses the current request. Returns an object so callers
 * can tell whether history was truncated.
 */
export function trimTurnsToTokens(
  turns: readonly ConversationTurn[],
  maxTokens: number,
): { turns: ConversationTurn[]; truncated: boolean } {
  if (turns.length === 0) return { turns: [], truncated: false };
  if (maxTokens <= 0) return { turns: [], truncated: true };

  const rendered = turns.map(renderTurnForPrompt);
  const tokenCosts = rendered.map((line) => estimateTokens(line) + 1);
  const total = tokenCosts.reduce((a, b) => a + b, 0);
  if (total <= maxTokens) return { turns: [...turns], truncated: false };

  let acc = 0;
  let startIndex = turns.length;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const cost = tokenCosts[i] ?? 0;
    if (acc + cost > maxTokens) break;
    acc += cost;
    startIndex = i;
  }

  const lastUserIndex = findLastUserIndex(turns);
  if (lastUserIndex !== -1 && lastUserIndex < startIndex) {
    startIndex = lastUserIndex;
  }

  return { turns: turns.slice(startIndex), truncated: startIndex > 0 };
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
