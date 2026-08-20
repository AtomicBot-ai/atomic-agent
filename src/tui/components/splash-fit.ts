/**
 * Fit maths for the start-page splash — which brand mark to draw, how
 * many tips to keep, and how wide the tip columns may be for a given
 * chat-surface size.
 *
 * The splash used to be a fixed 83×20 mark plus eight fixed tip rows,
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

export interface SplashFit {
  /** Which brand mark to draw, or `"none"` when nothing fits. */
  logo: LogoChoice;
  /** Whether the `ATOMIC AGENT` wordmark sits beside the mark. */
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
}

/**
 * Start-page tips in priority order — the tail is dropped first when
 * the surface runs out of rows, so the entries that keep a first-run
 * operator moving have to come first.
 */
export const SPLASH_TIPS: readonly SplashTip[] = [
  {
    label: "Enter",
    description: "submit message to the agent",
    short: "send message",
  },
  {
    label: "/help",
    description: "list all slash commands",
    short: "all commands",
  },
  {
    label: "/sessions",
    description: "switch to a previous thread",
    short: "past threads",
  },
  { label: "/new", description: "start a fresh session", short: "new session" },
  { label: "/model", description: "change the chat model", short: "pick model" },
  {
    label: "/tasks",
    description: "jump to the Tasks tab (cron + ingress UI)",
    short: "Tasks tab",
  },
  {
    label: "/import",
    description: "open the Import tab (Hermes migration)",
    short: "Hermes import",
  },
  {
    label: "Ctrl+C ×2",
    description: "quit (once aborts a running turn)",
    short: "quit",
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
  full: { width: 34, height: 20 },
  small: { width: 20, height: 12 },
  mini: { width: 7, height: 4 },
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

const VARIANTS_WIDEST_FIRST: readonly LogoVariant[] = ["full", "small", "mini"];

/** Width at which the mark and the wordmark fit side by side. */
const FULL_WITH_WORDMARK_WIDTH =
  LOGO_METRICS.full.width + WORDMARK_GAP + WORDMARK_WIDTH;

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

  // The wordmark is a 46-column luxury; it only rides along with the
  // full mark, and only once both fit side by side.
  const wordmark = logo === "full" && inner >= FULL_WITH_WORDMARK_WIDTH;
  const tagline = wordmark;

  const markRows =
    logo === "none" ? 0 : LOGO_METRICS[logo].height + TIP_LIST_MARGIN_ROWS;
  const spare = rows - markRows;
  const tipCount = Math.max(0, Math.min(SPLASH_TIPS.length, spare));
  const visible = SPLASH_TIPS.slice(0, tipCount);

  if (visible.length === 0) {
    return { logo, wordmark, tagline, tipCount: 0, labelWidth: 0, descriptions: "none" };
  }

  const longestLabel = maxLength(visible.map((tip) => tip.label));
  const longestFull = maxLength(visible.map((tip) => tip.description));
  const longestShort = maxLength(visible.map((tip) => tip.short));
  const tightLabel = longestLabel + 1;
  const budget = inner - TIP_PREFIX_WIDTH;

  if (budget >= TIP_LABEL_WIDE + longestFull) {
    return { logo, wordmark, tagline, tipCount, labelWidth: TIP_LABEL_WIDE, descriptions: "full" };
  }
  if (budget >= tightLabel + longestFull) {
    return { logo, wordmark, tagline, tipCount, labelWidth: tightLabel, descriptions: "full" };
  }
  if (budget >= tightLabel + longestShort) {
    return { logo, wordmark, tagline, tipCount, labelWidth: tightLabel, descriptions: "short" };
  }
  return { logo, wordmark, tagline, tipCount, labelWidth: 0, descriptions: "none" };
}
