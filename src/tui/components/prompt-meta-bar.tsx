import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";

/**
 * The composer's status bar: what the model is on the left, the live
 * readouts on the right, drawn on the same inverted ground as the rail.
 *
 * **Why inverted.** The bar is the composer's chrome, not its content.
 * A terminal has no borders-and-shadows to say "this strip is a
 * toolbar", so it borrows the one device the rail already established:
 * its own ground, per-palette rather than a literal white, because
 * `#fff` disappears on the four light themes. Reading the composer as
 * "a field with a toolbar under it" instead of "two lines of text" is
 * the whole point of the change.
 *
 * The ground is one `backgroundColor` on the bar container, which Ink 7
 * paints across the empty space between the meta text and the readouts —
 * no filler cells, and no risk of the row growing taller than it looks.
 *
 * Send used to live here, at the far right. It moved into the field
 * itself (`composer-send-button.tsx`): the bar's right end is where a
 * status readout belongs, and the app's primary verb belongs next to
 * the text it submits.
 *
 * **A caveat about the slots.** `leftSlot` / `rightSlot` arrive from the
 * chat surface already coloured (the LLM health pill, the while-busy
 * hint), and those colours were chosen against the *normal* ground.
 * On the rail ground they read as low-contrast secondary text — which is
 * what they are — but on `github-dark` and `catppuccin-mocha` the muted
 * tone is close enough to the light rail ground to be genuinely faint.
 * Recolouring them would mean reaching into components outside this
 * file; the glyph in each pill carries a saturated status colour and
 * stays legible, so the signal survives even where the label dims.
 */
export interface PromptMetaBarProps {
  /** Chat-surface content rendered first — normally the LLM health pill. */
  leftSlot: ReactElement | null;
  model: string | null;
  provider: string | null;
  /** Chat-surface content rendered at the bar's right end. */
  rightSlot: ReactElement | null;
}

const MODEL_LABEL_MAX_LEN = 32;

/**
 * Separator `runModeModelSummary` puts between the two fusion legs.
 * Matched here rather than imported as a run-mode concept: this file
 * only needs to know that a label can be a pair, so that it can spend
 * its budget on both halves instead of on the first one.
 */
const PAIR_SEPARATOR = " ⇄ ";

export function PromptMetaBar({
  leftSlot,
  model,
  provider,
  rightSlot,
}: PromptMetaBarProps): ReactElement {
  return (
    <Box
      flexDirection="row"
      justifyContent="space-between"
      backgroundColor={theme.colors.railBackground}
      paddingX={1}
      // Matches the buffer's own padding above. The rows carry no
      // foreground, so the bar's ground paints straight through them and
      // the model name and the readouts sit inside a block rather than
      // on a stripe.
      paddingY={1}
    >
      {/*
        The meta group is the only thing allowed to give up columns: at
        60 the right-hand readout must survive intact, because a
        half-drawn chip is worse than a truncated model name.
      */}
      <Box flexShrink={1} minWidth={0}>
        <MetaLeft leftSlot={leftSlot} model={model} provider={provider} />
      </Box>
      <Box flexShrink={0} flexDirection="row">
        {rightSlot ?? null}
      </Box>
    </Box>
  );
}

interface MetaLeftProps {
  leftSlot: ReactElement | null;
  model: string | null;
  provider: string | null;
}

function MetaLeft({ leftSlot, model, provider }: MetaLeftProps): ReactElement {
  if (!leftSlot && !model && !provider) {
    return <Text> </Text>;
  }
  const cleanModel = model ? formatModel(model) : null;
  // Wrap the optional `leftSlot` in a `<Text>` so neighbouring spans
  // (a leading dot separator before the model) stay on the same line
  // without Yoga inserting an inline break between Box children.
  // `truncate` rather than wrap: a second line here would push the
  // frame's bottom border down and change the composer's height, which
  // is exactly the kind of drift a bounded frame exists to prevent.
  return (
    <Text wrap="truncate">
      {leftSlot ? <Text>{leftSlot}</Text> : null}
      {leftSlot && (cleanModel || provider) ? (
        <Text color={theme.colors.railMuted}>
          {" "}
          {theme.glyphs.dotSeparator}{" "}
        </Text>
      ) : null}
      {cleanModel ? (
        <Text color={theme.colors.accent} bold>
          {cleanModel}
        </Text>
      ) : null}
      {cleanModel && provider ? (
        <Text color={theme.colors.railMuted}>
          {" "}
          {theme.glyphs.dotSeparator}{" "}
        </Text>
      ) : null}
      {provider ? (
        <Text color={theme.colors.railMuted}>{provider}</Text>
      ) : null}
    </Text>
  );
}

function formatModel(model: string): string {
  // Fusion names both legs. Truncating the joined string would eat the
  // local half whole and leave "anthropic/claude-sonnet-4.5 ⇄ q…", which
  // says less than either name alone would: the reader can no longer
  // tell which local model is executing. Each side gets half the budget
  // so both stay identifiable at the width the row already had.
  const [cloud, local] = model.split(PAIR_SEPARATOR);
  if (cloud !== undefined && local !== undefined) {
    const half = Math.floor((MODEL_LABEL_MAX_LEN - PAIR_SEPARATOR.length) / 2);
    return `${shorten(cloud, half)}${PAIR_SEPARATOR}${shorten(local, half)}`;
  }
  return shorten(model, MODEL_LABEL_MAX_LEN);
}

function shorten(label: string, max: number): string {
  const stripped = label.replace(/\.gguf$/i, "");
  if (stripped.length <= max) return stripped;
  return `${stripped.slice(0, max - 1)}…`;
}
