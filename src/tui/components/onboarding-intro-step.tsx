import { Box, Text } from "ink";
import { useMemo, type ReactElement } from "react";
import { useTypewriter } from "../hooks/use-typewriter.js";
import { buildIntroArt } from "../onboarding/intro-art.js";
import type { OnboardingFit } from "../onboarding/onboarding-fit.js";
import { starTierOfGlyph, type StarTier } from "../onboarding/star-tiers.js";
import { theme } from "../theme/theme.js";
import { CROSS_MARKS } from "./logo-art.js";
import { WORDMARK_ROWS, TAGLINE } from "./logo.js";

/** Milliseconds per revealed character. ~0.9s for the whole tagline. */
export const TAGLINE_MS_PER_CHAR = 45;
/**
 * Rows the intro spends on everything that is not the sky: the screen's
 * own top padding, two of wordmark, the tagline, the "press any key"
 * line, every margin between them, and the pinned footer. The art gets
 * what is left, and nothing more — Ink 7 overlaps rather than clips, so
 * one row over budget costs the footer.
 *
 * It was 9 while the art still had blank rows in it. An empty `Text`
 * measures zero rows in Ink, so the old ring's unused top and bottom
 * lines were quietly paying for two of these; a sky reaches every row
 * and the debt came due.
 */
export const INTRO_CHROME_ROWS = 10;
/** `ATOMIC` is the first 23 columns of the shipped `ATOMIC AGENT` wordmark. */
const WORDMARK_ATOMIC_COLUMNS = 23;

interface SkyTier {
  /** Multiplier on the field's designed star density. */
  density: number;
  /** Stars in the arc around the mark. Zero drops the arc. */
  halo: number;
}

/**
 * How much sky each size tier gets. A smaller terminal is thinned rather
 * than emptied: the count already scales with the canvas, and cutting it
 * further is what keeps a cramped screen from reading as noise.
 */
const SKY_BY_TIER: Readonly<Record<OnboardingFit["tier"], SkyTier>> = {
  full: { density: 1, halo: 26 },
  reduced: { density: 0.75, halo: 14 },
  minimal: { density: 0.5, halo: 0 },
};

const FACE_GLYPHS = new Set(["█", "#"]);
const PRESS_ANY_KEY = "[ press any key to continue ]";

/**
 * The first screen of a first run: the mark in a field of stars, the
 * wordmark, and the tagline typing itself in.
 *
 * The animation is a courtesy, not a gate — any key completes it, and a
 * second key moves on. Everything but the tagline paints instantly, so
 * the screen is legible from frame one.
 */
export function OnboardingIntroStep(props: {
  columns: number;
  rows: number;
  fit: OnboardingFit;
  /** True once a key has been pressed: finish the reveal immediately. */
  skipAnimation: boolean;
}): ReactElement {
  const { fit } = props;
  // The mark is chosen by the rows actually left over, not by the tier
  // alone: Ink 7 overlaps rather than clips, so a mark one row too tall
  // does not get cropped — it pushes the tagline and the footer off the
  // screen and paints over whatever was there.
  const budget = props.rows - INTRO_CHROME_ROWS;
  const markRows =
    fit.tier !== "minimal" && budget >= CROSS_MARKS.block.md.length
      ? CROSS_MARKS.block.md
      : budget >= CROSS_MARKS.block.sm.length
        ? CROSS_MARKS.block.sm
        : [];
  const sky = SKY_BY_TIER[fit.tier];
  const columns = Math.max(20, props.columns);
  const rows = Math.max(markRows.length, budget);
  // The tagline re-renders this component every few dozen milliseconds.
  // The field is seeded, so recomputing it would give the same stars
  // back — but there is no reason to redraw a few hundred of them per
  // keystroke of an animation.
  const art = useMemo(
    () =>
      buildIntroArt({
        columns,
        rows,
        markRows,
        density: sky.density,
        haloCount: sky.halo,
      }),
    [columns, rows, markRows, sky.density, sky.halo],
  );
  const { revealed, done } = useTypewriter(TAGLINE, {
    active: true,
    msPerChar: TAGLINE_MS_PER_CHAR,
    skip: props.skipAnimation,
  });
  const wordmark = WORDMARK_ROWS.map((row) =>
    row.slice(0, WORDMARK_ATOMIC_COLUMNS),
  );

  // The art rows already carry their own centring, so the block is laid
  // out left-aligned and everything below it is padded to the same
  // measure. Centring each row on its own would make them jitter as the
  // tagline grows.
  const pad = (text: string): string =>
    " ".repeat(Math.max(0, Math.floor((props.columns - text.length) / 2))) + text;
  const cursor = done ? "" : "▌";

  return (
    <Box flexDirection="column" flexShrink={0}>
      {art.map((row, index) => (
        <ArtRow key={index} row={row} />
      ))}
      <Box flexDirection="column" marginTop={1}>
        {wordmark.map((row, index) => (
          <Text key={index} bold color={theme.colors.accentSoft} wrap="truncate">
            {pad(row)}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        {/*
          Padded by the *finished* tagline's width, so the line is
          anchored where it will end up instead of sliding left as each
          character lands.
        */}
        <Text color={theme.colors.muted} wrap="truncate">
          {`${" ".repeat(Math.max(0, Math.floor((props.columns - TAGLINE.length) / 2)))}${revealed}${cursor}`}
        </Text>
      </Box>
      {/*
        One row of air, not two. The second was the row the footer needed
        back once the art started filling its whole budget.
      */}
      <Box marginTop={1}>
        <Text color={theme.colors.accent} wrap="truncate">
          {pad(PRESS_ANY_KEY)}
        </Text>
      </Box>
    </Box>
  );
}

/** A run of the art row: part of the mark, or a star of one brightness. */
type RunKind = "face" | "depth" | StarTier;

/**
 * One row of the art. Split into runs so each brightness carries its own
 * colour and the mark's face and depth keep theirs; the glyph ramp
 * underneath encodes the same thing, which is what keeps the sky
 * readable with colour stripped.
 */
function ArtRow({ row }: { row: string }): ReactElement {
  const runs: { text: string; kind: RunKind }[] = [];
  for (const glyph of row) {
    const kind: RunKind =
      starTierOfGlyph(glyph) ?? (FACE_GLYPHS.has(glyph) ? "face" : "depth");
    const last = runs[runs.length - 1];
    if (last && last.kind === kind) last.text += glyph;
    else runs.push({ text: glyph, kind });
  }
  return (
    <Text wrap="truncate">
      {runs.map((run, index) => (
        <Text key={index} bold={BOLD_KINDS.has(run.kind)} color={colorFor(run.kind)}>
          {run.text}
        </Text>
      ))}
    </Text>
  );
}

/** The mark is solid, and the brightest stars are the ones that glare. */
const BOLD_KINDS: ReadonlySet<RunKind> = new Set<RunKind>(["face", "depth", "bright"]);

function colorFor(kind: RunKind): string {
  switch (kind) {
    case "face":
    case "bright":
      return theme.colors.brandFace;
    case "depth":
    case "mid":
      return theme.colors.brandMark;
    case "dim":
      return theme.colors.accent;
    case "faint":
      return theme.colors.accentSoft;
  }
}
