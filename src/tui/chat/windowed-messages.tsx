import { Box, type DOMElement } from "ink";
import type { ReactElement } from "react";
import type { CodingMode } from "../coding-mode/coding-mode.js";
import type { TurnFold } from "../render/turn-collapse.js";
import type { ChatMessage, TuiState } from "../tui-state.js";
import { FinalisedMessage } from "./chat-finalised-message.js";

interface WindowedMessagesProps {
  /** The whole finalised history; only `[start, end)` is drawn. */
  readonly messages: readonly ChatMessage[];
  readonly start: number;
  readonly end: number;
  /** Ref for the box around each drawn message, so its rows get measured. */
  readonly refFor: (id: string) => (node: DOMElement | null) => void;
  readonly state: TuiState;
  readonly fusion: boolean;
  readonly folds: ReadonlyMap<string, TurnFold>;
  readonly onPlanExecute?: (mode: CodingMode) => void;
  readonly onPlanDismiss?: () => void;
}

/**
 * The finalised messages inside the chat log's window (ATO-650), each in
 * a plain column box the height cache measures. The box adds no rows:
 * a column's height is its child's, margins included.
 */
export function WindowedMessages({
  messages,
  start,
  end,
  refFor,
  state,
  fusion,
  folds,
  onPlanExecute,
  onPlanDismiss,
}: WindowedMessagesProps): ReactElement {
  const last = messages.length - 1;
  return (
    <>
      {messages.slice(start, end).map((message, k) => (
        <Box
          key={message.id}
          ref={refFor(message.id)}
          flexDirection="column"
          flexShrink={0}
        >
          <FinalisedMessage
            message={message}
            toolsExpandedById={state.toolsExpandedById}
            fusion={fusion}
            fold={folds.get(message.id) ?? null}
            turnOpen={state.turnsExpandedById[message.id] === true}
            // The plan's own buttons, under the plan. Only the last
            // message can carry them: the offer is about the newest
            // plan, and an older one further up the log would be an
            // offer to run something that has already been superseded.
            planHandoff={
              state.planHandoff &&
              start + k === last &&
              message.role === "assistant" &&
              onPlanExecute !== undefined &&
              onPlanDismiss !== undefined
                ? { onExecute: onPlanExecute, onDismiss: onPlanDismiss }
                : null
            }
          />
        </Box>
      ))}
    </>
  );
}
