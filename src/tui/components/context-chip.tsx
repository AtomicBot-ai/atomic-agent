import { Text } from "ink";
import type { ReactElement } from "react";
import { MouseTarget, useMouseCommands } from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import type { ContextUsageView } from "../select-context-usage.js";
import { mixColor } from "../theme/mix-color.js";
import { readableOn } from "../theme/readable-foreground.js";
import { theme } from "../theme/theme.js";
import { formatTokens } from "./format-tokens.js";
import { renderProgressBar } from "./render-progress-bar.js";

/** Cells of gauge. Eight reads as a bar and still fits a 56-column bar. */
const GAUGE_WIDTH = 8;

/**
 * Share of the toolbar's own ground mixed into the accent at each step.
 *
 * Fading *toward the ground the chip sits on* is what makes one rule
 * work on a light palette and a dark one: `classic-light`'s deep blue
 * pulled most of the way to its pale rail is literally pale blue,
 * `toxic-green`'s acid green pulled to its dark rail is a quiet dimmed
 * green, and both say the same thing — this control is not asking for
 * attention yet. The chip gets louder as the window fills.
 *
 * The two values are not eyeballed. `readable-foreground.test.ts` walks
 * every palette and fails if either mixed step drops below a 4.5:1
 * contrast ratio against the ink `readableOn` picks for it; these are
 * the largest fades that clear it on all six.
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
 *
 * Clicking it opens the breakdown — see `context-panel.tsx`. That is
 * what makes the button ground honest rather than decorative.
 */
export function ContextChip({
  usage,
  layer,
}: {
  usage: ContextUsageView;
  /**
   * Mouse layer for the click target. Rendered inside the composer
   * overlay, which floats above the chat log, so the chat surface
   * passes the overlay's raised layer — otherwise a covered chat
   * control could win the click.
   */
  layer?: number;
}): ReactElement {
  const background = groundFor(usage);
  const label = ` context ${chipBody(usage)} `;
  const chip = (
    <Text backgroundColor={background} color={readableOn(background)} bold>
      {label}
    </Text>
  );
  const mouse = useMouseCommands();
  // No provider (component tests, the wizard's separate Ink tree):
  // render the label and stop. A target that swallows the click without
  // acting would be worse than no target.
  if (!mouse) return chip;
  return (
    <MouseTarget
      flexShrink={0}
      layer={layer}
      onMouse={(hit) => {
        if (!isPrimaryPress(hit.event)) return false;
        mouse.dispatch({ type: "context_panel_toggled" });
        return true;
      }}
    >
      {chip}
    </MouseTarget>
  );
}

/**
 * What the chip prints after the word `context`.
 *
 * The window first, whenever anything knows it. The gauge used to
 * measure the *transcript against its own cap*, which is a real number
 * and the wrong one to lead with: it is a budget internal to the
 * packer, it moves for reasons the operator did not cause, and it says
 * nothing about the question actually being asked at the composer —
 * *is there room for what I am about to send, and has anything already
 * been forgotten?*
 *
 * So: `39.9k/48k`, prompt against the model's real window, gauged.
 * Where turns have already been dropped the chip says so in words,
 * because that is the moment the agent stops knowing things it knew a
 * minute ago and the answers start quietly getting worse. A colour
 * alone was never going to carry that.
 *
 * With no window known — a cloud model nobody published a length for —
 * it falls back to the transcript gauge, which is the only scale that
 * still exists. A bar drawn against a window nobody knows would be a
 * fabrication.
 */
export function chipBody(usage: ContextUsageView): string {
  const lost = usage.droppedTurns > 0 ? ` · ${usage.droppedTurns} lost` : "";
  if (usage.contextWindow !== null && usage.percent !== null) {
    return `[${renderProgressBar(usage.percent, GAUGE_WIDTH)}] ${pair(
      usage.tokens,
      usage.contextWindow,
    )}${lost}`;
  }
  if (usage.conversationCap === null || usage.conversationPercent === null) {
    // Nothing has set a scale yet. The total is still worth showing — it
    // is the only number that says whether this session is big.
    return `${formatTokens(usage.tokens)}${lost}`;
  }
  return `[${renderProgressBar(
    usage.conversationPercent,
    GAUGE_WIDTH,
  )}] ${pair(usage.conversationTokens, usage.conversationCap)} cap${lost}`;
}

/** The chip's ground: three steps of accent, then violet once trimmed. */
export function groundFor(usage: ContextUsageView): string {
  if (usage.droppedTurns > 0) return theme.colors.accentAlt;
  const ground = theme.colors.railBackground;
  const accent = theme.colors.accent;
  // The ramp follows the same number the bar does — how full the window
  // is — so the chip gets louder as room runs out. Unknown fill sits at
  // the quiet end: that is a readout of a session which has barely
  // started, not a warning about one that has not.
  const fill = usage.percent ?? usage.conversationPercent;
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

/**
 * Fits `115.3k/131.1k` — a full 128k window, which is the widest pair
 * an ordinary session produces. It was 10 while the right-hand number
 * was the transcript's own cap and never had a `k` on both sides;
 * gauging the window put one there, and a field that was too short
 * would let the pair grow a cell as the prompt crossed 100k and shove
 * the whole gauge sideways mid-session.
 */
const PAIR_WIDTH = 13;

