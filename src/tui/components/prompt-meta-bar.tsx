import { Box, Text } from "ink";
import type { ReactElement } from "react";
import {
  ComposerMetaControls,
  LEG_SEPARATOR,
} from "../composer-switch/composer-meta-controls.js";
import type { ComposerBackendMeta } from "../composer-switch/composer-backend-selectors.js";
import { fusionBarGround, fusionInk } from "../theme/fusion-tint.js";
import { useTerminalSize } from "../hooks/use-terminal-size.js";
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
  /**
   * Re-skin the bar for the Fusion run mode: black ground, white ink,
   * orange accents — see `fusion-tint.ts`. The blue the bar normally
   * wears is the ordinary state, and leaving it under an orange chip
   * made fusion look like a badge on the normal composer.
   */
  fusion?: boolean;
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

/**
 * Ceiling on the model label — and nothing more than a ceiling.
 *
 * This was **32**, applied before the row was laid out, so a 170-column
 * terminal with eighty columns of slack still rendered
 * `anthropic/claude-sonnet-4.5-2025…` and a fusion pair came out as
 * `vendor/some-v… ⇄ qwen3-4b-inst…`. A pre-truncation cannot know the
 * width it is fitting into. Yoga can, and already does: every control in
 * `ComposerMetaControls` is `wrap="truncate"` with a `flexShrink` order
 * (model 3, provider 1, backend 0) chosen so the model gives first, and
 * the two fusion legs are separate controls with a rigid swap glyph
 * between them, so each is cut on its own. Measured at bar widths
 * 70/90/119/140/170/200: the full name survives from 90 up, both legs
 * from 119 up, and below that each is trimmed separately and stays
 * identifiable — which is what the fixed budget was trying to buy.
 *
 * So the cut is the layout's. This number exists only so a pathological
 * name — a 300-character local filename — cannot set the flex row's
 * min-content width and bully the readouts off it. Wide enough that no
 * real cloud id or GGUF stem reaches it.
 */
const MODEL_LABEL_CEILING = 96;

/**
 * How eagerly a chat-surface slot gives up columns, against the route
 * controls' own factors (model 3, provider 1, backend 0). Exported
 * because the slot carries it: the slot goes straight into this row, so
 * it owns its own shrink order.
 *
 * It used to be `0` — the slot never shrank, so a provider-outage
 * readout took the left end of the bar outright and pushed the entire
 * route statement off it. At 110 columns the row said nothing at all:
 * the readout itself was cut away and the provider, the one thing an
 * operator looks left for when the link is down, had gone with it.
 *
 * An order of magnitude above the route's factors rather than a
 * hairline above them, because Yoga shrinks *proportionally*: at 4 the
 * model would still give up a quarter of every lost column.
 *
 * The outage readout does not use it. Yoga leaves an item at full width
 * rather than shrink it by more than it has to give (measured: composer
 * width 119, a 31-column reason with this factor gave up nothing and
 * the route was clipped off the row), so the readout's reason grows
 * into the leftovers from a basis of zero instead. Growth Yoga resolves
 * reliably; large shrinks it does not.
 */
export const META_SLOT_SHRINK = 40;

/**
 * Separator `selectPromptLlmMeta` puts between the two fusion legs.
 * The same constant the controls split on — this file spends the label
 * budget on both halves, `ComposerMetaControls` hangs the swap button
 * on the seam, and one of them moving without the other would leave a
 * pair that truncates as a pair but no longer comes apart.
 */
const PAIR_SEPARATOR = LEG_SEPARATOR;

/**
 * Below this width the bar stacks into two columns of two rows each.
 *
 * Measured rather than picked: the one-row composition has to seat the
 * route statement (backend dot, provider, and a model name that is now
 * only ceilinged, not budgeted — see `MODEL_LABEL_CEILING` — and in
 * Fusion *two* legs with a separator between them), the context gauge
 * with its bar and both token counts, and the coding-mode chip. Around
 * 120 columns the route runs out of room first, and Yoga answers by
 * truncating it: `aiml…`, `deepseek/…`. Both of those are the readout's
 * whole content — a provider you cannot name and a model you cannot
 * identify — so the row has stopped saying anything by the time it still
 * fits.
 *
 * Stacking buys back the full width for each line instead of splitting
 * it four ways: route and gauge get a line each on the left, and the
 * mode control gets a label above it on the right, which is the one
 * place the bar can say what that chip *is*.
 */
export const STACK_BELOW_COLUMNS = 120;

/**
 * Rows the window must have before the bar is allowed to spend one on
 * stacking. The second line comes out of the chat, and on a short
 * window that is the worse trade: a truncated provider name is a
 * nuisance, a chat two replies shorter is the app.
 *
 * Measured, not assumed: at 80x24 with a four-line draft the taller
 * composer pushes its own controls past the viewport — the overlay
 * mouse suite fails on exactly that, with the Send target no longer
 * taking clicks. 30 leaves the stacked bar comfortably inside a window
 * that can afford it and keeps every classic 24-row terminal on the
 * single row it was laid out for.
 */
export const STACK_MIN_ROWS = 30;

export function PromptMetaBar({
  leftSlot,
  backend,
  model,
  provider,
  needsModelDownload,
  fusion = false,
  rightSlot,
  contextSlot,
  modeSlot,
  mouseLayer,
}: PromptMetaBarProps): ReactElement {
  const { columns, rows } = useTerminalSize();
  const ground = fusion ? fusionBarGround() : theme.colors.railBackground;
  const label = fusion ? fusionInk() : theme.colors.railMuted;
  const left = (
    <MetaLeft
      leftSlot={leftSlot}
      backend={backend}
      model={model}
      provider={provider}
      needsModelDownload={needsModelDownload ?? false}
      fusion={fusion}
      mouseLayer={mouseLayer}
    />
  );
  if (columns > 0 && columns < STACK_BELOW_COLUMNS && rows >= STACK_MIN_ROWS) {
    return (
      <Box
        flexDirection="row"
        justifyContent="space-between"
        backgroundColor={ground}
        paddingX={1}
        paddingY={1}
      >
        {/* Route above its own gauge: both get the column's full width
            instead of a quarter of the row's. */}
        <Box
          flexDirection="column"
          flexGrow={1}
          flexShrink={1}
          minWidth={0}
          overflow="hidden"
        >
          {left}
          {contextSlot ? <Box minWidth={0}>{contextSlot}</Box> : null}
        </Box>
        {/*
          `marginLeft` so a route trimmed to the last column does not butt
          straight into `Coding mode:` — measured at bar width 90 with a
          fusion pair, where the two ran together with no space between
          them.
        */}
        <Box
          flexDirection="column"
          flexShrink={0}
          alignItems="flex-end"
          marginLeft={1}
        >
          {rightSlot ? <Box flexShrink={0}>{rightSlot}</Box> : null}
          {modeSlot ? (
            <>
              <Text color={label}>Coding mode:</Text>
              <Box flexShrink={0}>{modeSlot}</Box>
            </>
          ) : null}
        </Box>
      </Box>
    );
  }
  return (
    <Box
      flexDirection="row"
      justifyContent="space-between"
      backgroundColor={ground}
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
        half-drawn chip is worse than a truncated model name. It also
        takes the row's slack (`flexGrow`) rather than leaving it between
        the two groups, so a slot that fills the leftovers — the outage
        reason — has leftovers to fill.
      */}
      <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
        {left}
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
  fusion: boolean;
  mouseLayer?: number;
}

/**
 * A row of Boxes rather than one `<Text>` of spans, because the three
 * route labels are clickable and a click target is a Box — Ink cannot
 * nest one inside a `<Text>`.
 *
 * That costs the free truncation the single `<Text wrap="truncate">`
 * used to give the whole group, so the row has to fit by shrinking: the
 * slot goes first (`META_SLOT_SHRINK`, or its own arrangement — see the
 * outage readout), then the route labels in the order
 * `ComposerMetaControls` sets. Every `<Text>` in here is `truncate` for
 * the same reason — one that wrapped would take the composer's bottom
 * border down a line with it.
 *
 * The slot is rendered as it arrives, not wrapped in a `<Text>` of this
 * file's own: it can be a click target, and a click target is a Box,
 * which Ink cannot nest inside a `<Text>`. Callers hand over an element
 * that truncates itself — and may hand over more than one box, which is
 * how the outage readout keeps a rigid head next to a reason that gives
 * way.
 */
function MetaLeft({
  leftSlot,
  backend,
  model,
  provider,
  needsModelDownload,
  fusion,
  mouseLayer,
}: MetaLeftProps): ReactElement {
  if (!leftSlot && !backend && !model && !provider && !needsModelDownload) {
    return <Text> </Text>;
  }
  const cleanModel = model ? formatModel(model) : null;
  const hasRoute = Boolean(
    backend || provider || cleanModel || needsModelDownload,
  );
  return (
    <Box
      flexDirection="row"
      flexGrow={1}
      flexShrink={1}
      minWidth={0}
      // One row, clipped. Ink wraps rather than clips, and a second line
      // here would take the composer's bottom border down with it. The
      // slot is rendered as it arrives — it can be a click target, and a
      // click target is a Box, which Ink cannot nest inside a `<Text>` —
      // so this file can no longer impose `wrap="truncate"` on it, and
      // this is the belt to the caller's braces.
      height={1}
      overflow="hidden"
    >
      {/*
        Straight into the row, not inside a group box of its own. A
        rigid item can only defend its columns on the line that is doing
        the shrinking: nested one level down, the outage readout's
        `flexShrink={0}` head sat inside a group that had itself shrunk
        below the width of its children, and the `overflow="hidden"`
        below clipped the very counter the head exists to protect
        (measured at bar width 100 — see `prompt-meta-bar.test.tsx`).
        Flat, the head sits next to the backend word as another
        unshrinkable item and the reason after it is what gives way.
      */}
      {leftSlot}
      {leftSlot && hasRoute ? (
        <Box flexShrink={0}>
          <Text color={theme.colors.railMuted} wrap="truncate">
            {" "}
            {theme.glyphs.dotSeparator}{" "}
          </Text>
        </Box>
      ) : null}
      <ComposerMetaControls
        backend={backend}
        provider={provider}
        model={cleanModel}
        needsModelDownload={needsModelDownload}
        fusion={fusion}
        mouseLayer={mouseLayer}
      />
    </Box>
  );
}

function formatModel(model: string): string {
  // Fusion names both legs. Truncating the joined string would eat the
  // local half whole and leave "anthropic/claude-sonnet-4.5 ⇄ q…", which
  // says less than either name alone would: the reader can no longer
  // tell which local model is executing. Each side gets half the ceiling
  // so one pathological name cannot spend the other's share; the cut the
  // row actually needs is Yoga's, and it lands on the two legs
  // separately.
  const [cloud, local] = model.split(PAIR_SEPARATOR);
  if (cloud !== undefined && local !== undefined) {
    const half = Math.floor((MODEL_LABEL_CEILING - PAIR_SEPARATOR.length) / 2);
    return `${shorten(cloud, half)}${PAIR_SEPARATOR}${shorten(local, half)}`;
  }
  return shorten(model, MODEL_LABEL_CEILING);
}

function shorten(label: string, max: number): string {
  const stripped = label.replace(/\.gguf$/i, "");
  if (stripped.length <= max) return stripped;
  return `${stripped.slice(0, max - 1)}…`;
}
