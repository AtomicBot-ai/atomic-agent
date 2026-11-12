/**
 * ATO-490: the composer's reasoning level, on its way from the window to
 * the agent. The window sends `low` / `medium` / `high` for a chat that
 * picked one (renderer/reasoning-switch.js); Auto sends nothing. Here it is
 * checked once more and becomes OpenAI's own `reasoning_effort` on
 * `POST /v1/chat/completions`, which the agent reads as the turn's level
 * (src/llm/reasoning-levels.ts). An agent from before the field ignores it.
 */

export type ReasoningLevel = "low" | "medium" | "high";

/** A value from the window as a level, or `undefined` (Auto, or anything else). */
export function reasoningLevelFromWindow(value: unknown): ReasoningLevel | undefined {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

/** The request body's field for a level: `{ reasoning_effort }`, or nothing. */
export function reasoningBodyField(level: ReasoningLevel | undefined): { reasoning_effort?: ReasoningLevel } {
  return level === undefined ? {} : { reasoning_effort: level };
}
