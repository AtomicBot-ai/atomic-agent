import { Text } from "ink";
import type { ReactElement } from "react";
import {
  activeLimits,
  pickHeadlineLimit,
  usageStatusParts,
  type SessionUsageState,
} from "../../session/usage-meter.js";
import { fusionInk } from "../theme/fusion-tint.js";
import { theme } from "../theme/theme.js";

/**
 * The cost and limit half of the composer readout (ATO-569), drawn right
 * after the context chip: ` · $0.31 · 17% left, resets 15:00`.
 *
 * Only parts with data: no call yet, no text at all. `null` from
 * {@link usageReadoutLabel} means the readout takes no columns, which
 * the meta-bar planner (`selectMetaBarFit`) relies on.
 *
 * Every glyph is single-width, so `String.length` is the rendered width.
 */
export function usageReadoutLabel(
  usage: SessionUsageState | null,
  now: number,
): string | null {
  const parts = usageStatusParts(usage ?? undefined, now);
  return parts.length === 0 ? null : ` · ${parts.join(" · ")} `;
}

/**
 * Warn colour once the headline limit is nearly spent: 10% or less
 * left, or the provider says the limit is reached. Spend never turns the
 * readout a warning colour on its own: there is no budget here to be
 * over (that is G1's per-turn budget).
 */
export function usageReadoutUrgent(
  usage: SessionUsageState | null,
  now: number,
): boolean {
  if (!usage) return false;
  const headline = pickHeadlineLimit(activeLimits(usage.limits, now), now);
  if (!headline) return false;
  return headline.status === "rejected" || (headline.usedPercent ?? 0) >= 90;
}

export function UsageReadout({
  usage,
  now,
  fusion = false,
}: {
  usage: SessionUsageState | null;
  now: number;
  fusion?: boolean;
}): ReactElement | null {
  const label = usageReadoutLabel(usage, now);
  if (label === null) return null;
  const color = usageReadoutUrgent(usage, now)
    ? theme.colors.warn
    : fusion
      ? fusionInk()
      : theme.colors.railMuted;
  return <Text color={color}>{label}</Text>;
}
