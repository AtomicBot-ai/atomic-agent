import { Text } from "ink";
import type { ReactElement } from "react";

import type { LlmHealthState } from "../llm-health/llm-health-state.js";
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
  const { color, glyph, label } = resolveBadge(health);
  return (
    <Text>
      <Text color={color} bold>
        {glyph}
      </Text>
      <Text color={theme.colors.muted}> {label}</Text>
    </Text>
  );
}

interface BadgeLook {
  color: string;
  glyph: string;
  label: string;
}

function resolveBadge(health: LlmHealthState): BadgeLook {
  switch (health.status) {
    case "healthy":
      return { color: theme.colors.success, glyph: "●", label: "healthy" };
    case "probing":
      return { color: theme.colors.warn, glyph: "◐", label: "probing" };
    case "unreachable":
      return { color: theme.colors.muted, glyph: "○", label: "down" };
    case "error":
      return { color: theme.colors.error, glyph: "✕", label: "error" };
    case "unknown":
    default:
      return { color: theme.colors.muted, glyph: "·", label: "unknown" };
  }
}
