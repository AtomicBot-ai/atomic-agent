import {
  REASONING_LEVELS,
  type ReasoningLevel,
} from "../../llm/reasoning-levels.js";
import type { ReasoningEffort } from "../../llm/provider/completion-types.js";

/**
 * `/think` (ATO-490): how hard the model thinks on this window's turns.
 * The same four levels as the desktop composer's switch and the chat
 * API's `reasoning_effort` (`src/llm/reasoning-levels.ts`):
 *
 *   /think                          say the level in force and the choices
 *   /think auto|low|medium|high     set it for the turns sent from here
 *
 * `off` is read as `low`: no level turns thinking off on every model
 * (the core never sends a value that could fail a request), and the
 * lightest it can ask for is `low`. Saying so beats refusing a word
 * people will type first, the way Claude Code's thinking toggle is "off".
 *
 * A session setting, never written to `config.json`, like the coding
 * mode: it holds for every chat in this window until it is changed.
 * `auto` sends nothing, so the model's own config decides as before.
 */
export type ThinkCommand =
  | { kind: "show" }
  | { kind: "set"; level: ReasoningLevel; fromOff?: boolean }
  | { kind: "error"; message: string };

export const THINK_USAGE = "usage: /think [auto | low | medium | high]";

const ALIASES: Readonly<Record<string, ReasoningLevel>> = {
  off: "low",
  min: "low",
  med: "medium",
  max: "high",
  default: "auto",
};

export function parseThinkCommand(args: string): ThinkCommand {
  const word = args.trim().toLowerCase();
  if (word.length === 0) return { kind: "show" };
  if ((REASONING_LEVELS as readonly string[]).includes(word)) {
    return { kind: "set", level: word as ReasoningLevel };
  }
  const alias = ALIASES[word];
  if (alias !== undefined) {
    return word === "off"
      ? { kind: "set", level: alias, fromOff: true }
      : { kind: "set", level: alias };
  }
  return { kind: "error", message: `unknown level: ${args.trim()}. ${THINK_USAGE}` };
}

/** What a turn sends: nothing for `auto`, the level otherwise. */
export function reasoningOverrideFor(level: ReasoningLevel): ReasoningEffort | undefined {
  return level === "auto" ? undefined : level;
}

/** The confirmation line after `/think <level>`, or the answer to bare `/think`. */
export function describeThinkLevel(level: ReasoningLevel, fromOff = false): string {
  const choices = `Choices: ${REASONING_LEVELS.join(", ")}.`;
  if (level === "auto") {
    return `Reasoning: auto. The model thinks as its config says. ${choices}`;
  }
  const head = fromOff
    ? "Reasoning: low (the lightest level; thinking cannot be turned off on every model)."
    : `Reasoning: ${level}, for the next turns in this window.`;
  return `${head} A model that does not reason ignores it. ${choices}`;
}

/**
 * The composer readout beside the step speed: ` · think high`. `null`
 * for `auto`, which takes no columns (`selectMetaBarFit` relies on it).
 * Every glyph is single-width, so `String.length` is the width.
 */
export function thinkReadoutLabel(level: ReasoningLevel | undefined): string | null {
  return level === undefined || level === "auto" ? null : ` · think ${level}`;
}
