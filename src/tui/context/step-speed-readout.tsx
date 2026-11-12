import { Text } from "ink";
import type { ReactElement } from "react";
import { formatStepSpeedParts, type StepSpeed } from "../../llm/step-speed.js";
import { fusionInk } from "../theme/fusion-tint.js";
import { theme } from "../theme/theme.js";

/**
 * The speed half of the composer readout (ATO-631), drawn right after
 * the context chip: ` · 12 tok/s · cache 92%`, plus `read 30k in 41s`
 * when the prompt read was the slow part and `draft 71%` under
 * speculative decoding.
 *
 * It answers the one question a slow reply raises: was the model
 * re-reading the prompt, or writing slowly? The KV hit share used to
 * live only in the debug line (`kv N%`), and the decode rate only in
 * the startup probe.
 *
 * `null` means the readout takes no columns, which the meta-bar planner
 * (`selectMetaBarFit`) relies on. Every glyph is single-width, so
 * `String.length` is the rendered width.
 */
export function stepSpeedReadoutLabel(
  speed: StepSpeed | null | undefined,
): string | null {
  const parts = formatStepSpeedParts(speed ?? null);
  return parts.length === 0 ? null : ` · ${parts.join(" · ")}`;
}

export function StepSpeedReadout({
  speed,
  fusion = false,
}: {
  speed: StepSpeed | null | undefined;
  fusion?: boolean;
}): ReactElement | null {
  const label = stepSpeedReadoutLabel(speed);
  if (label === null) return null;
  return (
    <Text color={fusion ? fusionInk() : theme.colors.railMuted}>{label}</Text>
  );
}
