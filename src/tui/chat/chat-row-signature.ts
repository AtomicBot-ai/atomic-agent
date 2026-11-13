import type { ChatMessage } from "../tui-state.js";
import type { RowSignature } from "./use-measured-row-heights.js";

export type ChatRowFold = "none" | "closed" | "open";

export interface ChatRowRenderInput {
  readonly fold: ChatRowFold;
  readonly fusion: boolean;
  readonly toolsExpandedById: Readonly<Record<string, boolean>>;
  /** Whether the plan's buttons are drawn under this message. */
  readonly planHandoff: boolean;
}

/**
 * Everything besides the terminal width that can change how many rows a
 * finalised message takes without changing its id (ATO-650): its turn
 * fold, which of its tool cards are expanded, the Fusion tint and the
 * plan buttons. The windowed chat log keys each measured height by this
 * and the width, so "expand all" marks an off-screen message's kept
 * height stale instead of leaving it at its collapsed size. The text
 * length and card count are in it too, as a cheap guard for a message
 * replaced under the same id.
 */
export function chatRowSignature(
  message: ChatMessage,
  input: ChatRowRenderInput,
): string {
  const cards = message.toolCards ?? [];
  const expanded = cards
    .filter((card) => input.toolsExpandedById[card.id] === true)
    .map((card) => card.id)
    .join(",");
  return [
    input.fold,
    input.fusion ? "f" : "",
    input.planHandoff ? "p" : "",
    message.text.length,
    cards.length,
    expanded,
  ].join("|");
}

export interface ChatRowSignaturesInput {
  readonly messages: readonly ChatMessage[];
  readonly columns: number;
  readonly foldOf: (id: string) => ChatRowFold;
  readonly fusion: boolean;
  readonly toolsExpandedById: Readonly<Record<string, boolean>>;
  /**
   * Whether the plan's buttons would be drawn under the newest message
   * if it is the assistant's: the same condition `WindowedMessages` uses.
   */
  readonly planButtons: boolean;
}

/**
 * The `RowSignature` of every finalised message by id, for one frame.
 * An id that is not a message (the live rows under them) is keyed by
 * the width alone.
 */
export function chatRowSignatures(
  input: ChatRowSignaturesInput,
): (id: string) => RowSignature {
  const indexById = new Map(input.messages.map((m, idx) => [m.id, idx]));
  const last = input.messages.length - 1;
  return (id) => {
    const idx = indexById.get(id);
    const message = idx === undefined ? undefined : input.messages[idx];
    if (message === undefined) return { columns: input.columns, render: "" };
    return {
      columns: input.columns,
      render: chatRowSignature(message, {
        fold: input.foldOf(id),
        fusion: input.fusion,
        toolsExpandedById: input.toolsExpandedById,
        planHandoff:
          input.planButtons && idx === last && message.role === "assistant",
      }),
    };
  };
}
