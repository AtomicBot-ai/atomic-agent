import { ConfigValidationError } from "../config-validation-error.js";
import { emitConfigNoticeOnce } from "../config-primitives.js";

/**
 * `agent.prompt.compact`: whether the stable prefix uses the compact
 * scaffold (short tool descriptions, rare tools as one-liners, a shorter
 * persona, a smaller skill catalog). `auto` turns it on when the model's
 * known context window is at most 64K tokens; an unknown window keeps
 * the full scaffold. See `src/prompt/compact-prompt.ts`.
 */
export type CompactPromptMode = "auto" | "on" | "off";
export const COMPACT_PROMPT_MODES: readonly CompactPromptMode[] = ["auto", "on", "off"];

export interface PromptConfig {
  compact: CompactPromptMode;
}

export function createPromptDefaults(): PromptConfig {
  return { compact: "auto" };
}

/**
 * Lenient on an unknown string, strict on a wrong type: a newer build
 * may write a mode this build does not know (the desktop app and the
 * terminal share one config file), and that must read as the default
 * rather than fail every command. Same rule as #1020's
 * `isSetAsideString`; switch to that helper once it is on main.
 */
function parseCompactPromptMode(raw: unknown, fallback: CompactPromptMode): CompactPromptMode {
  if (typeof raw !== "string") {
    throw new ConfigValidationError("agent.prompt.compact", `expected one of ${COMPACT_PROMPT_MODES.join(", ")}`);
  }
  if ((COMPACT_PROMPT_MODES as readonly string[]).includes(raw)) return raw as CompactPromptMode;
  emitConfigNoticeOnce(
    `config: agent.prompt.compact "${raw}" is not a value this build knows; using "${fallback}"`,
  );
  return fallback;
}

export function parsePromptConfig(raw: unknown, defaults: PromptConfig): PromptConfig {
  if (raw == null) return { ...defaults };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError("agent.prompt", "expected an object");
  }
  const input = raw as Record<string, unknown>;
  return {
    compact: parseCompactPromptMode(input.compact ?? defaults.compact, defaults.compact),
  };
}
