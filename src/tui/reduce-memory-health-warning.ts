import type { AgentLoopEvent } from "../agent/agent-loop.js";
import { appendChatMessage, appendFeed } from "./reducer-helpers.js";
import type { TuiState } from "./tui-state.js";

export type MemoryHealthWarningEvent = Extract<
  AgentLoopEvent,
  { type: "memory_health_warning" }
>;

const KIND_LABEL: Readonly<Record<MemoryHealthWarningEvent["kind"], string>> =
  {
    reflection: "reflection",
    link_generator: "link generation",
    vote: "voting",
    rewriter: "query rewriter",
  };

/**
 * A memory sub-call that keeps timing out or failing, said in the chat
 * and not only the feed. The sub-calls run after the reply, so a broken
 * one leaves nothing on screen: the agent just stops learning, which is
 * invisible from the chat and the feed tab alike. A `system` notice —
 * never an assistant bubble, it is the runtime speaking — styled `warn`
 * like the fallover notice. The runtime already emits it once per
 * session and sub-call, so there is nothing to dedupe here.
 */
export function reduceMemoryHealthWarning(
  state: TuiState,
  event: MemoryHealthWarningEvent,
): TuiState {
  const verb = event.outcome === "timeout" ? "timed out" : "failed";
  return appendFeed(
    appendChatMessage(state, {
      role: "system",
      variant: "warn",
      text: event.message,
    }),
    {
      kind: "runtime_info",
      stepIndex: null,
      line: `» memory ${KIND_LABEL[event.kind]} ${verb} ${event.consecutive}× in a row — ${event.setting}`,
      color: "yellow",
    },
  );
}
