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
 * **What the gauge measures.** The transcript against the ceiling it is
 * packed to, not the prompt against the model's window. The window is
 * the wrong scale for a bar: a 1M-token model sits at 1% all session and
 * the gauge never says anything. The transcript's cap is the number that
 * moves, and reaching it is precisely when `packConversation` starts
 * dropping the oldest turns — so the bar filling up *is* the warning.
 *
 * It is also the only scale that always exists. The window is unknown on
 * any cloud model nobody has published a context length for;
 * `conversationCapEffective` is on every built prompt, falling back to
 * the configured cap when there is no window to clamp against.
 *
 * Both numbers are printed beside the bar. Nothing here is measured
 * against a scale the operator cannot see.
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
    usage.conversationCap === null || usage.conversationPercent === null
      ? // No prompt has set a cap yet (or it came back as zero). The
        // total is still worth showing — it is the only number that says
        // whether this session is big — but a gauge drawn against a
        // scale nobody stated would be a fabrication.
        ` context ${formatTokens(usage.tokens)} `
      : ` context [${renderProgressBar(
          usage.conversationPercent,
          GAUGE_WIDTH,
        )}] ${pair(usage.conversationTokens, usage.conversationCap)} `;
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
  // The ramp follows the same number the bar does: how close the
  // transcript is to being trimmed. Unknown fill sits at the quiet end —
  // that is a readout of a session which has barely started, not a
  // warning about one that has not.
  const fill = usage.conversationPercent;
  if (fill === null || fill < STEP_LOW) return mixColor(accent, ground, FADE_LOW);
  if (fill < STEP_MID) return mixColor(accent, ground, FADE_MID);
  return accent;
}

/**
 * `6400 / 32000` -> ` 6.4k/32k`, right-aligned in a fixed field.
 *
 * The padding is not cosmetic: the bar sits to the left of this text and
 * the chip is right-anchored on the toolbar, so a tail that grew a cell
 * as the transcript crossed 10k would shift the whole gauge sideways on
 * an ordinary turn.
 */
function pair(tokens: number, cap: number): string {
  return `${formatTokens(tokens)}/${formatTokens(cap)}`.padStart(PAIR_WIDTH);
}

/** Fits `999.9k/1.0M`; anything longer simply grows past it. */
const PAIR_WIDTH = 10;

/**
 * `1240` -> `1.2k`, `32000` -> `32k`, `1000000` -> `1.0M`. Terminals have
 * no room for six digits of nuance, and a round thousand reads better
 * without the `.0` it would otherwise carry.
 */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) {
    const k = tokens / 1000;
    return Number.isInteger(k) ? `${k}k` : `${k.toFixed(1)}k`;
  }
  const m = tokens / 1_000_000;
  return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1)}M`;
}
