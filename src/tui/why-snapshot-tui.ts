import { describeToolCall } from "../tools/describe-tool-call.js";
import { resultSizeLabel, stepArgsLabel } from "./chat/step-note.js";
import type { ToolCardEntry, TuiState } from "./tui-state.js";

/**
 * `/why` (ATO-34): a short plain account of the agent's last step,
 * from what the TUI already holds for the visible session: the last
 * finished tool card (live turn first, then the newest finished turn),
 * the model's reasoning text when it gave any, and the last model
 * call's token counts. Nothing is invented: a part the data does not
 * carry is said to be missing.
 */
export type WhyState = Pick<
  TuiState,
  "messages" | "streamingToolCards" | "reasoning" | "metrics"
>;

const WHY_REASONING_LIMIT = 240;
const WHY_ARGS_LIMIT = 120;

/** Cards that are the reply itself, not a step the agent took. */
function isStepCard(card: ToolCardEntry): boolean {
  return (
    card.status !== "pending" && card.tool !== "reply" && card.tool !== "finish"
  );
}

interface LastStep {
  card: ToolCardEntry;
  /** The model's reasoning tied to this step, if any. */
  reasoning: string | null;
  /** `true` when the reasoning is the turn's last block, not this step's own. */
  reasoningIsTurnLevel: boolean;
}

/** The newest finished step: the running turn's, else the last finished turn's. */
export function findLastStep(state: WhyState): LastStep | null {
  const live = [...state.streamingToolCards].reverse().find(isStepCard);
  if (live) {
    const own = state.reasoning
      .filter((r) => r.stepIndex === live.stepIndex)
      .map((r) => r.text.trim())
      .filter((t) => t.length > 0);
    return {
      card: live,
      reasoning: own.length > 0 ? own.join(" ") : null,
      reasoningIsTurnLevel: false,
    };
  }
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    const message = state.messages[i]!;
    if (message.role !== "assistant" || !message.toolCards) continue;
    const card = [...message.toolCards].reverse().find(isStepCard);
    if (!card) continue;
    // A finished turn keeps its reasoning blocks without step numbers,
    // so the best honest answer is the turn's last block, labelled so.
    const blocks = (message.reasoningBlocks ?? [])
      .map((b) => b.trim())
      .filter((b) => b.length > 0);
    const last = blocks[blocks.length - 1];
    return {
      card,
      reasoning: last ?? null,
      reasoningIsTurnLevel: last !== undefined,
    };
  }
  return null;
}

function clipOneLine(text: string, limit: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= limit ? one : `${one.slice(0, limit - 1)}…`;
}

function tokensLine(metrics: WhyState["metrics"]): string {
  const parts: string[] = [];
  if (metrics.promptTokensLast !== null) {
    parts.push(`${metrics.promptTokensLast.toLocaleString("en-US")} in`);
  }
  if (metrics.completionTokensLast !== null) {
    parts.push(`${metrics.completionTokensLast.toLocaleString("en-US")} out`);
  }
  if (metrics.llmDurationMsLast !== null) {
    parts.push(`model took ${(metrics.llmDurationMsLast / 1000).toFixed(1)}s`);
  }
  return parts.length > 0
    ? `Tokens (last model call): ${parts.join(" · ")}`
    : "Tokens: not reported for this turn";
}

/** The text `/why` prints into the chat log. */
export function formatWhy(state: WhyState): string {
  const last = findLastStep(state);
  if (last === null) {
    return "/why: no step has run in this session yet, so there is nothing to explain.";
  }
  const { card } = last;
  const described = describeToolCall({
    name: card.tool,
    args: card.args,
    ok: card.status === "ok",
  });
  const duration =
    card.finishedAt !== null ? ` in ${card.finishedAt - card.startedAt}ms` : "";
  const lines = [
    `Last step: step ${card.stepIndex + 1} · ${described.line}`,
    `Called: ${card.tool} ${stepArgsLabel(card.args, WHY_ARGS_LIMIT)}`,
    `Result: ${card.status === "ok" ? "ok" : "failed"}${duration} · ${resultSizeLabel(card.summary)}${card.truncated ? " (truncated)" : ""}`,
    tokensLine(state.metrics),
  ];
  if (last.reasoning !== null) {
    const label = last.reasoningIsTurnLevel
      ? "Why (the model's last reasoning in that turn)"
      : "Why (the model's reasoning for this step)";
    lines.push(`${label}: ${clipOneLine(last.reasoning, WHY_REASONING_LIMIT)}`);
  } else {
    lines.push(
      "Why: the model gave no reasoning for this step, so only the call and its result are shown.",
    );
  }
  return lines.join("\n");
}
