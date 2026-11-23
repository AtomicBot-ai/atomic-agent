import { Text } from "ink";
import type { ReactElement } from "react";
import type { ReasoningLevel } from "../../llm/reasoning-levels.js";
import { thinkReadoutLabel } from "../commands/think-command.js";
import { fusionInk } from "../theme/fusion-tint.js";
import { theme } from "../theme/theme.js";

/**
 * The `/think` level in the composer bar (ATO-490): ` · think high`,
 * after the step speed. Drawn only when a level is picked, as the
 * desktop composer's chip reads "Auto" until it is changed. Muted like
 * the speed beside it: a reading of what the next turn will ask for.
 */
export function ThinkReadout({
  level,
  fusion = false,
}: {
  level: ReasoningLevel | undefined;
  fusion?: boolean;
}): ReactElement | null {
  const label = thinkReadoutLabel(level);
  if (label === null) return null;
  return (
    <Text color={fusion ? fusionInk() : theme.colors.railMuted}>{label}</Text>
  );
}
