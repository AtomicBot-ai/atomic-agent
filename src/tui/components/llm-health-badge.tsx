import { Text } from "ink";
import type { ReactElement } from "react";

import type {
  LlmHealthState,
  LlmHealthStatus,
} from "../llm-health/llm-health-state.js";
import { theme } from "../theme/theme.js";

/**
 * Inline LLM health pill used in the `PromptShell` meta-row. Mirrors
 * the sidebar's `LlmCard` glyph + label palette (●/◐/○/✕/· paired with
 * `healthy` / `probing` / `down` / `error` / `unknown`) so the operator
 * sees the same vocabulary in both surfaces and never has to translate
 * one icon style into another.
 *
 * The badge renders the literal status word (no "llm" prefix) — the
 * surrounding meta-row context already implies it.
 */
export interface LlmHealthBadgeProps {
  health: LlmHealthState;
}

export function LlmHealthBadge({ health }: LlmHealthBadgeProps): ReactElement {
  const { color, glyph, label } = llmHealthLook(health.status);
  return (
    <Text>
      <Text color={color} bold>
        {glyph}
      </Text>
      <Text color={theme.colors.muted}> {label}</Text>
    </Text>
  );
}

export interface LlmHealthLook {
  color: string;
  glyph: string;
  label: string;
}

/**
 * Which ground the dot is about to be painted on.
 *
 * The same status is drawn in two places — this badge, on the terminal's
 * own page, and the composer's backend control, on the rail — and
 * contrast is a property of the pair, not of the colour. Asking the
 * caller which ground it owns is what lets one glyph table serve both
 * without either surface inventing a second one.
 */
export type LlmHealthGround = "page" | "rail";

/**
 * The ●/◐/○/✕/· vocabulary, resolved from a status and the ground it
 * lands on, so the composer's backend control can paint the same dot
 * this badge does.
 */
export function llmHealthLook(
  status: LlmHealthStatus,
  ground: LlmHealthGround = "page",
): LlmHealthLook {
  const c = theme.colors;
  const onRail = ground === "rail";
  const success = onRail ? c.railSuccess : c.success;
  const warn = onRail ? c.railWarn : c.warn;
  const error = onRail ? c.railError : c.error;
  const muted = onRail ? c.railMuted : c.muted;
  switch (status) {
    case "healthy":
      return { color: success, glyph: "●", label: "healthy" };
    case "probing":
      return { color: warn, glyph: "◐", label: "probing" };
    case "unreachable":
      return { color: muted, glyph: "○", label: "down" };
    case "error":
      return { color: error, glyph: "✕", label: "error" };
    case "unknown":
    default:
      return { color: muted, glyph: "·", label: "unknown" };
  }
}
