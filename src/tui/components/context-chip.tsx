import { Text } from "ink";
import type { ReactElement } from "react";
import type { ContextUsageView } from "../select-context-usage.js";
import { mixColor } from "../theme/mix-color.js";
import { readableOn } from "../theme/readable-foreground.js";
import { theme } from "../theme/theme.js";
import { renderProgressBar } from "./render-progress-bar.js";

/** Cells of gauge. Eight reads as a bar and still fits a 56-column bar. */
const GAUGE_WIDTH = 8;

/**
 * Share of the toolbar's own ground mixed into the accent at each step.
 *
 * Fading *toward the ground the chip sits on* is what makes one rule
 * work on a light palette and a dark one: `github-light`'s deep blue
 * pulled most of the way to its near-white rail is literally pale blue,
 * `tokyo-night`'s blue pulled to its dark rail is a quiet dimmed blue,
 * and both say the same thing — this control is not asking for
 * attention yet. The chip gets louder as the window fills.
 *
 * The two values are not eyeballed. `readable-foreground.test.ts` walks
 * every palette and fails if either mixed step drops below a 4.5:1
 * contrast ratio against the ink `readableOn` picks for it; these are
 * the largest fades that clear it on all twelve.
 */
const FADE_LOW = 0.6;
const FADE_MID = 0.3;

/** Percent boundaries between the three blues. */
const STEP_LOW = 33;
const STEP_MID = 66;

/**
 * The composer's context readout: how full the model's window is, drawn
 * as a button because it behaves like one.
 *
 * **Why a gauge and not a number.** The window is the one budget an
 * operator cannot see any other way — the transcript on screen is not
 * the transcript in the prompt, because tool output is compressed on the
 * way in, old macro-turns render at a reduced footprint, and
 * `packConversation` drops the oldest turns outright when the section
 * cap bites. A bar answers "how much room is left" at a glance; the
 * exact figure is one click away.
 *
 * **Why the colour ramp.** Three steps of the palette's own accent, then
 * violet once the transcript has been trimmed. Violet rather than a warn
 * colour on purpose: trimming is the design working, not a fault, and
 * `warn` would send an operator looking for the error that is not there.
 * It is also the only signal for that state — no counter, no glyph. The
 * detail view says how many turns went.
 *
 * **Why occupancy and not spend.** Context here is not monotonic: it
 * falls when the packer trims and when the memory fabric lifts facts out
 * of the transcript. A cumulative token counter would climb past 100%
 * and answer a question nobody asked.
 */
export function ContextChip({
  usage,
}: {
  usage: ContextUsageView;
}): ReactElement {
  const background = groundFor(usage);
  const label =
    usage.percent === null
      ? // No window to divide by. The count alone is still worth having —
        // it is the only number that says whether this session is big —
        // but a gauge drawn against a scale nobody stated would be a
        // fabrication.
        ` context ${formatTokens(usage.tokens)} `
      : ` context [${renderProgressBar(usage.percent, GAUGE_WIDTH)}] ${String(
          usage.percent,
        ).padStart(3)}% `;
  return (
    <Text backgroundColor={background} color={readableOn(background)} bold>
      {label}
    </Text>
  );
}

/** The chip's ground: three steps of accent, then violet once trimmed. */
export function groundFor(usage: ContextUsageView): string {
  if (usage.droppedTurns > 0) return theme.colors.accentAlt;
  const ground = theme.colors.railBackground;
  const accent = theme.colors.accent;
  // Unknown fill sits at the quiet end. It is a readout of a session
  // that has barely started, not a warning about one that has not.
  if (usage.percent === null || usage.percent < STEP_LOW) {
    return mixColor(accent, ground, FADE_LOW);
  }
  if (usage.percent < STEP_MID) return mixColor(accent, ground, FADE_MID);
  return accent;
}

/** `1240` -> `1.2k`. Terminals have no room for six digits of nuance. */
function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  return `${(tokens / 1000).toFixed(1)}k`;
}
