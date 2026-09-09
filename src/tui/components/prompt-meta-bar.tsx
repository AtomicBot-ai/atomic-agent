import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { ComposerMetaControls } from "../composer-switch/composer-meta-controls.js";
import type { ComposerBackendMeta } from "../composer-switch/composer-switch-rows.js";
import { theme } from "../theme/theme.js";

/**
 * The composer's status bar: the chat route on the left, the live
 * readouts on the right, drawn on the same inverted ground as the rail.
 *
 * **Why its own ground.** The bar is the composer's chrome, not its
 * content. A terminal has no borders-and-shadows to say "this strip is
 * a toolbar", so it borrows the one device the rail already
 * established: its own ground, one step off the page rather than an
 * inversion of it. Reading the composer as "a field with a toolbar
 * under it" instead of "two lines of text" is the whole point of the
 * change.
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
 * **About the slots.** `leftSlot` / `rightSlot` arrive from the chat
 * surface already coloured, so this file cannot check them — but they
 * land on the rail ground, which means the caller has to paint them in
 * `rail*` tokens rather than page ones. It used not to: the composer
 * notice came in as `success` and the while-busy hint as `accentSoft`
 * plus `muted`, all three picked to be read on the terminal's own
 * background, and on the palettes whose rail was drawn *inverted* that
 * put light text on a light ground. `tui-app.tsx` now hands over rail
 * tokens, and `theme-contrast.test.ts` holds every one of them to AA
 * against `railBackground`.
 */
export interface PromptMetaBarProps {
  /**
   * Chat-surface content rendered first — today only the transient
   * composer notice. The LLM health pill that used to live here folded
   * into the backend control, which now carries the same dot.
   */
  leftSlot: ReactElement | null;
  /** The route's backend kind and its health dot; `null` hides it. */
  backend: ComposerBackendMeta | null;
  model: string | null;
  provider: string | null;
  /** Turns the model slot into a `download model` call to action. */
  needsModelDownload?: boolean;
  /** Chat-surface content rendered at the bar's right end. */
  rightSlot: ReactElement | null;
  /**
   * The context readout, rendered at the bar's right end. Its own prop
   * rather than part of `rightSlot` because the two coexist: while a
   * turn runs `rightSlot` carries the Enter-routing hint, and the window
   * is exactly as worth watching then as when the composer is idle.
   */
  contextSlot: ReactElement | null;
  /**
   * The coding-mode chip, at the very end of the bar. Its own prop
   * rather than part of `rightSlot` for the same reason `contextSlot`
   * is: the three coexist, and the bar's right end is an ordered
   * sentence — how full the window is, then under what rules.
   */
  modeSlot: ReactElement | null;
  /**
   * Layer the route controls register their click targets on. The
   * composer floats over the chat log behind a raised mouse backstop
   * (see `composer-overlay.tsx`); controls left on the base layer would
   * lose every click to it.
   */
  mouseLayer?: number;
}

const MODEL_LABEL_MAX_LEN = 32;

/**
 * How eagerly the chat-surface slot gives up columns, against the route
 * controls' own factors (model 3, provider 1, backend 0).
 *
 * It used to be `0` — the slot never shrank, so a provider-outage
 * readout took the left end of the bar outright and pushed the entire
 * route statement off it. At 110 columns the row said nothing at all:
 * the readout itself was cut away and the provider, the one thing an
 * operator looks left for when the link is down, had gone with it.
 *
 * An order of magnitude above the route's factors rather than a
 * hairline above them, because Yoga shrinks *proportionally*: at 4 the
 * model would still give up a quarter of every lost column. The
 * intended degradation is the whole route plus a truncated readout, and
 * a factor this size is what expresses "this one goes first" in a
 * layout engine that has no such notion.
 */
const SLOT_SHRINK = 40;

/**
 * Separator `runModeModelSummary` puts between the two fusion legs.
 * Matched here rather than imported as a run-mode concept: this file
 * only needs to know that a label can be a pair, so that it can spend
 * its budget on both halves instead of on the first one.
 */
const PAIR_SEPARATOR = " ⇄ ";

export function PromptMetaBar({
  leftSlot,
  backend,
  model,
  provider,
  needsModelDownload,
  rightSlot,
  contextSlot,
  modeSlot,
  mouseLayer,
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
      <Box flexShrink={1} minWidth={0} overflow="hidden">
        <MetaLeft
          leftSlot={leftSlot}
          backend={backend}
          model={model}
          provider={provider}
          needsModelDownload={needsModelDownload ?? false}
          mouseLayer={mouseLayer}
        />
      </Box>
      <Box flexShrink={0} flexDirection="row">
        {rightSlot ? (
          <Box flexShrink={0} marginRight={2}>
            {rightSlot}
          </Box>
        ) : null}
        {contextSlot ?? null}
        {modeSlot ? (
          <Box flexShrink={0} marginLeft={1}>
            {modeSlot}
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

interface MetaLeftProps {
  leftSlot: ReactElement | null;
  backend: ComposerBackendMeta | null;
  model: string | null;
  provider: string | null;
  needsModelDownload: boolean;
  mouseLayer?: number;
}

/**
 * A row of Boxes rather than one `<Text>` of spans, because the three
 * route labels are clickable and a click target is a Box — Ink cannot
 * nest one inside a `<Text>`.
 *
 * That costs the free truncation the single `<Text wrap="truncate">`
 * used to give the whole group, so the row has to fit by shrinking: the
 * slot and its separator go first (`SLOT_SHRINK`), then the route labels
 * in the order `ComposerMetaControls` sets. Every `<Text>` in here is
 * `truncate` for the same reason — one that wrapped would take the
 * composer's bottom border down a line with it.
 *
 * The slot is rendered as it arrives, not wrapped in a `<Text>` of this
 * file's own: it can be a click target, and a click target is a Box,
 * which Ink cannot nest inside a `<Text>`. Callers hand over an element
 * that truncates itself.
 */
function MetaLeft({
  leftSlot,
  backend,
  model,
  provider,
  needsModelDownload,
  mouseLayer,
}: MetaLeftProps): ReactElement {
  if (!leftSlot && !backend && !model && !provider && !needsModelDownload) {
    return <Text> </Text>;
  }
  const cleanModel = model ? formatModel(model) : null;
  const hasRoute = Boolean(backend || provider || cleanModel || needsModelDownload);
  return (
    <Box flexDirection="row" flexShrink={1} minWidth={0}>
      {leftSlot ? (
        <Box
          flexDirection="row"
          flexShrink={SLOT_SHRINK}
          minWidth={0}
          // The belt to the caller's braces. The slot is rendered as it
          // arrives — it can be a click target, and a click target is a
          // Box, which Ink cannot nest inside a `<Text>` — so this file
          // can no longer impose `wrap="truncate"` on it. A slot that
          // forgot to truncate itself would wrap, and a wrapped meta bar
          // takes the composer's bottom border down a line with it. One
          // row, clipped.
          height={1}
          overflow="hidden"
        >
          {leftSlot}
          {hasRoute ? (
            // Inside the shrinking group but not shrinking itself: the
            // three cells it costs are what keep a truncated readout
            // from running into the route, and a separator that gave up
            // columns of its own turned into a second ellipsis sitting
            // next to the readout's.
            <Box flexShrink={0}>
              <Text color={theme.colors.railMuted} wrap="truncate">
                {" "}
                {theme.glyphs.dotSeparator}{" "}
              </Text>
            </Box>
          ) : null}
        </Box>
      ) : null}
      <ComposerMetaControls
        backend={backend}
        provider={provider}
        model={cleanModel}
        needsModelDownload={needsModelDownload}
        mouseLayer={mouseLayer}
      />
    </Box>
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
