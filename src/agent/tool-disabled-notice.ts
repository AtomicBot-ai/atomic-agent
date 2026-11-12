import type { DroppedTool } from "../llm/provider/completion-types.js";

/**
 * ATO-1417. The provider sent a request without one of the session's
 * tools because the server refused that tool's JSON schema (ATO-1399:
 * LM Studio and llama.cpp reject some MCP schemas outright), so the model
 * cannot call it. Before this event the only trace was a log line, and
 * the person saw a model that simply never used their tool. Rides the
 * `AgentLoopEvent` union so the TUI and the HTTP stream can say it in the
 * chat.
 *
 * Emitted once per tool per turn: every step of the turn sends the same
 * tool list, and so is refused and resent the same way.
 */
export interface ToolDisabledEvent {
  type: "tool_disabled";
  stepIndex: number;
  /** The tool's own name, as the registry knows it. */
  tool: string;
  /** `schema_rejected`: the server did not accept its JSON schema. */
  reason: DroppedTool["reason"];
}

/** The chat line for a `tool_disabled` event, shared by the TUI and the HTTP frame. */
export function toolDisabledNotice(tool: string): string {
  return `Tool ${tool} is disabled for this turn: the model server did not accept its schema.`;
}

/**
 * The `tool_disabled` events a completion calls for: one per dropped
 * tool that this turn has not announced yet. `announced` is the turn's
 * own set of tool names and is updated in place.
 */
export function toolDisabledEvents(
  droppedTools: readonly DroppedTool[] | undefined,
  announced: Set<string>,
  stepIndex: number,
): ToolDisabledEvent[] {
  if (!droppedTools || droppedTools.length === 0) return [];
  const events: ToolDisabledEvent[] = [];
  for (const dropped of droppedTools) {
    if (!dropped.name || announced.has(dropped.name)) continue;
    announced.add(dropped.name);
    events.push({
      type: "tool_disabled",
      stepIndex,
      tool: dropped.name,
      reason: dropped.reason,
    });
  }
  return events;
}
