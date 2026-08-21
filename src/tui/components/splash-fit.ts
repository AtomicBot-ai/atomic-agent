/**
 * Fit maths for the start-page splash — which brand mark to draw, how
 * many tips to keep, and how wide the tip columns may be for a given
 * chat-surface size.
 *
 * The splash used to be a fixed 83×20 mark plus the fixed tip rows,
 * i.e. it needed 90 columns and ~29 rows no matter what the terminal
 * offered. Ink 7 does not clip an over-tall frame — it overlaps
 * earlier lines (see `../row-window.ts`) — so a short window garbled
 * the whole start page, and a narrow one wrapped the artwork into
 * confetti.
 *
 * The mark has priority over the tip list: a window that grows tall
 * enough for a bigger mark spends its new rows on the artwork first, so
 * the tip count can legitimately drop across a variant change. Within a
 * variant the list only ever grows.
 *
 * This module is deliberately React-free so the breakpoints can be
 * unit-tested as a table instead of through rendered frames.
 */

export type LogoVariant = "full" | "small" | "mini";

/**
 * What the splash draws for a mark. `"none"` is a real outcome, not a
 * failure: below ~8 rows the mark and the tips cannot both fit, and Ink
 * paints an over-tall frame *over* the rows above it rather than
 * clipping — so drawing it anyway is what garbled the start page in the
 * first place. The tips are the useful half at that size.
 */
export type LogoChoice = LogoVariant | "none";

export interface SplashSize {
  columns: number;
  rows: number;
}

export type TipDescriptions = "full" | "short" | "none";

/**
 * Where the wordmark goes relative to the mark. `full` is 51 columns
 * wide — parking a 46-column wordmark beside it needs 100 columns of
 * chat surface, which is a 140-column terminal. Stacking it underneath
 * needs only the mark's own width, so the big mark keeps its name on
 * ordinary terminals instead of going anonymous above 100 columns.
 */
export type WordmarkPlacement = "beside" | "below" | "none";

export interface SplashFit {
  /** Which brand mark to draw, or `"none"` when nothing fits. */
  logo: LogoChoice;
  /** Where the `ATOMIC AGENT` wordmark sits, if it is drawn at all. */
  wordmarkPlacement: WordmarkPlacement;
  /** Whether the `ATOMIC AGENT` wordmark is drawn. */
  wordmark: boolean;
  /** Whether the "Local AI-First Agent" tagline is drawn. */
  tagline: boolean;
  /** How many tips fit, taken from the head of `SPLASH_TIPS`. */
  tipCount: number;
  /** Padded width of the tip label column (0 when unpadded). */
  labelWidth: number;
  /** Which description text to pair with each tip label. */
  descriptions: TipDescriptions;
}

export interface SplashTip {
  label: string;
  /** Roomy copy, used when the surface can carry it. */
  description: string;
  /** Terse copy for narrow surfaces. */
  short: string;
  /**
   * What a click on the row puts in the composer. Every tip is a slash
   * command now — the two rows that were plain hotkeys (`Enter`,
   * `Ctrl+C ×2`) are gone, because a hint you cannot click reads as a
   * broken control next to seven you can, and the hint strip already
   * carries both keys at the foot of the screen.
   */
  command: string;
}

/**
 * Start-page tips in priority order — the tail is dropped first when
 * the surface runs out of rows, so the entries that keep a first-run
 * operator moving have to come first.
 */
export const SPLASH_TIPS: readonly SplashTip[] = [
  {
    label: "/help",
    description: "list all slash commands",
    short: "all commands",
    command: "/help",
  },
  {
    label: "/sessions",
    description: "switch to a previous thread",
    short: "past threads",
    command: "/sessions",
  },
  {
    label: "/new",
    description: "start a fresh session",
    short: "new session",
    command: "/new",
  },
  {
    label: "/model",
    description: "change the chat model",
    short: "pick model",
    command: "/model",
  },
  {
    label: "/tasks",
    description: "jump to the Tasks tab (cron + ingress UI)",
    short: "Tasks tab",
    command: "/tasks",
  },
  {
    label: "/import",
    description: "open the Import tab (Hermes migration)",
    short: "Hermes import",
    command: "/import",
  },
];

interface LogoMetrics {
  width: number;
  height: number;
}

/**
 * Rendered footprint of each mark, in cells. Kept beside the art in
 * `logo.tsx` by `logo-fit.test.ts`, which re-measures the row data and
 * fails if the two ever drift apart.
 */
export const LOGO_METRICS: Readonly<Record<LogoVariant, LogoMetrics>> = {
  full: { width: 51, height: 24 },
  small: { width: 31, height: 14 },
  mini: { width: 9, height: 5 },
};

/** `ATOMIC AGENT` half-block wordmark, plus the gap that precedes it. */
export const WORDMARK_WIDTH = 46;
const WORDMARK_GAP = 3;

/** `paddingX` on the splash container. */
const SPLASH_PADDING_X = 2;
/** `"  • "` in front of every tip label. */
const TIP_PREFIX_WIDTH = 4;
/** Roomy tip-label column, matching the pre-adaptive layout. */
const TIP_LABEL_WIDE = 24;
/** Tips are worth keeping only if a few of them survive together. */
const MIN_TIPS = 3;
/** One blank row separates the mark from the tip list. */
const TIP_LIST_MARGIN_ROWS = 1;

/**
 * A row the splash never spends, so its content is always at least one
 * row short of the pane it is rendered into.
 *
 * Without it the fit lands *exactly* on the pane height at roughly half
 * of all terminal sizes — including all three at which the wordmark was
 * reported truncated. Ink 7 overlaps rather than clips (see
 * `../row-window.ts`), so at an exact fit any one-row disagreement
 * between the budgeted viewport and the real pane — a wrapped hint
 * strip, a terminal reporting one more row than it shows — is paid for
 * by painting over a row that is already drawn, rather than by leaving
 * a blank one empty.
 *
 * This is hardening, not a proven fix: the artwork itself is emitted
 * intact at every size swept, so if the truncation survives it is
 * downstream of the row data.
 */
const SPLASH_SLACK_ROWS = 1;

/**
 * Rows a stacked wordmark costs: one blank, its own two, and the
 * tagline under it. Beside the mark all of that is free — the mark is
 * taller than the wordmark and tagline together — so this is the only
 * arrangement that has to pay for them.
 */
export const WORDMARK_STACK_ROWS = 4;

const VARIANTS_WIDEST_FIRST: readonly LogoVariant[] = ["full", "small", "mini"];

/** Width at which `variant` and the wordmark fit side by side. */
function lockupWidth(variant: LogoVariant): number {
  return LOGO_METRICS[variant].width + WORDMARK_GAP + WORDMARK_WIDTH;
}

/**
 * Marks big enough to carry the wordmark beside them. `mini` is nine
 * columns; parked next to a 46-column wordmark it reads as a bullet
 * point rather than a lockup.
 */
const WORDMARK_VARIANTS: readonly LogoVariant[] = ["full", "small"];

/**
 * Where `variant`'s wordmark can go on this surface, if anywhere.
 * Beside it when both fit a line, stacked underneath when they do not
 * but the rows are there, and nowhere when neither works.
 */
function placementFor(
  variant: LogoVariant,
  inner: number,
  rows: number,
): WordmarkPlacement {
  if (!WORDMARK_VARIANTS.includes(variant)) return "none";
  if (lockupWidth(variant) <= inner) return "beside";
  if (
    WORDMARK_WIDTH <= inner &&
    LOGO_METRICS[variant].height +
      WORDMARK_STACK_ROWS +
      TIP_LIST_MARGIN_ROWS +
      MIN_TIPS <=
      rows
  ) {
    return "below";
  }
  return "none";
}

function maxLength(values: readonly string[]): number {
  return values.reduce((acc, value) => Math.max(acc, value.length), 0);
}

/**
 * Resolve the splash layout for a chat surface of `size`.
 *
 * `size` is the space the splash itself owns — already net of the root
 * padding, the right rail and the prompt chrome (see `../layout.ts`).
 * Width picks the mark, height then downgrades it until at least
 * {@link MIN_TIPS} tips can sit underneath, and whatever rows are left
 * decide how much of the tip list survives.
 */
export function computeSplashFit(size: SplashSize): SplashFit {
  const inner = Math.max(0, size.columns - SPLASH_PADDING_X * 2);
  const rows = Math.max(0, size.rows);

  let index = VARIANTS_WIDEST_FIRST.findIndex(
    (variant) => LOGO_METRICS[variant].width <= inner,
  );
  if (index === -1) index = VARIANTS_WIDEST_FIRST.length - 1;
  while (
    index < VARIANTS_WIDEST_FIRST.length - 1 &&
    LOGO_METRICS[VARIANTS_WIDEST_FIRST[index]!]!.height +
      TIP_LIST_MARGIN_ROWS +
      MIN_TIPS >
      rows
  ) {
    index += 1;
  }
  // A bigger mark is not worth going nameless for. If the mark we
  // picked cannot carry the wordmark either way but the next size down
  // can, step down. Without this the start page LOSES its name as the
  // window grows — `full` is 24 rows and cannot stack the wordmark until
  // 32 rows of chat surface, so 28 rows drew a nameless full mark while
  // both 24 (small + wordmark) and 32 (full + wordmark) named the app.
  // Mark-over-tips is the documented priority; mark-over-wordmark is not.
  const nextDown = VARIANTS_WIDEST_FIRST[index + 1];
  if (
    nextDown !== undefined &&
    placementFor(VARIANTS_WIDEST_FIRST[index]!, inner, rows) === "none" &&
    placementFor(nextDown, inner, rows) !== "none"
  ) {
    index += 1;
  }

  let logo: LogoChoice = VARIANTS_WIDEST_FIRST[index]!;
  if (
    LOGO_METRICS[VARIANTS_WIDEST_FIRST[index]!]!.height +
      TIP_LIST_MARGIN_ROWS +
      1 >
      rows ||
    LOGO_METRICS[VARIANTS_WIDEST_FIRST[index]!]!.width > inner
  ) {
    logo = "none";
  }

  // The wordmark is a 46-column luxury; it rides along only with a mark
  // wide enough to balance it.
  const wordmarkPlacement: WordmarkPlacement =
    logo === "none" ? "none" : placementFor(logo, inner, rows);
  const wordmark = wordmarkPlacement !== "none";
  const tagline = wordmark;

  const markRows =
    logo === "none"
      ? 0
      : LOGO_METRICS[logo].height +
        (wordmarkPlacement === "below" ? WORDMARK_STACK_ROWS : 0) +
        TIP_LIST_MARGIN_ROWS;
  // Only when a mark is drawn: on a surface too small for one the tips
  // are all there is, and spending one of two rows on slack costs half
  // the page to guard artwork that is not on it.
  const spare =
    rows - markRows - (logo === "none" ? 0 : SPLASH_SLACK_ROWS);
  const tipCount = Math.max(0, Math.min(SPLASH_TIPS.length, spare));
  const visible = SPLASH_TIPS.slice(0, tipCount);

  if (visible.length === 0) {
    return { logo, wordmarkPlacement, wordmark, tagline, tipCount: 0, labelWidth: 0, descriptions: "none" };
  }

  const longestLabel = maxLength(visible.map((tip) => tip.label));
  const longestFull = maxLength(visible.map((tip) => tip.description));
  const longestShort = maxLength(visible.map((tip) => tip.short));
  const tightLabel = longestLabel + 1;
  const budget = inner - TIP_PREFIX_WIDTH;

  if (budget >= TIP_LABEL_WIDE + longestFull) {
    return { logo, wordmarkPlacement, wordmark, tagline, tipCount, labelWidth: TIP_LABEL_WIDE, descriptions: "full" };
  }
  if (budget >= tightLabel + longestFull) {
    return { logo, wordmarkPlacement, wordmark, tagline, tipCount, labelWidth: tightLabel, descriptions: "full" };
  }
  if (budget >= tightLabel + longestShort) {
    return { logo, wordmarkPlacement, wordmark, tagline, tipCount, labelWidth: tightLabel, descriptions: "short" };
  }
  return { logo, wordmarkPlacement, wordmark, tagline, tipCount, labelWidth: 0, descriptions: "none" };
}
