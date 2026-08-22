import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { useTypewriter } from "../hooks/use-typewriter.js";
import { buildIntroArt, ORBIT_GLYPH } from "../onboarding/intro-art.js";
import type { OnboardingFit } from "../onboarding/onboarding-fit.js";
import { theme } from "../theme/theme.js";
import { CROSS_MARKS } from "./logo-art.js";
import { WORDMARK_ROWS, TAGLINE } from "./logo.js";

/** Milliseconds per revealed character. ~0.9s for the whole tagline. */
export const TAGLINE_MS_PER_CHAR = 45;
/**
 * Rows the intro spends on everything that is not the ring: two of
 * wordmark, the tagline, the "press any key" line and their margins.
 * The art gets what is left of the budget it is handed.
 *
 * The pinned footer and the surface's top padding are not counted here
 * any more — `OnboardingScreen` takes both off the budget before it
 * passes it down. Counting the footer but neither the padding nor the
 * gap under the header is what made the splash come out two rows taller
 * than the terminal, which Ink 7 paints over the rows above rather than
 * clipping.
 */
export const INTRO_CHROME_ROWS = 8;
/** `ATOMIC` is the first 23 columns of the shipped `ATOMIC AGENT` wordmark. */
const WORDMARK_ATOMIC_COLUMNS = 23;

const FACE_GLYPHS = new Set(["█", "#"]);
const PRESS_ANY_KEY = "[ press any key to continue ]";

/**
 * The first screen of a first run: the mark inside a ring of smaller
 * crosses, the wordmark, and the tagline typing itself in.
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
  const crossCount = fit.tier === "full" ? 14 : fit.tier === "reduced" ? 8 : 0;
  const art = buildIntroArt({
    columns: Math.max(20, props.columns),
    rows: Math.max(markRows.length, budget),
    markRows,
    crossCount,
  });
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
      <Box marginTop={2}>
        <Text color={theme.colors.accent} wrap="truncate">
          {pad(PRESS_ANY_KEY)}
        </Text>
      </Box>
    </Box>
  );
}

/**
 * One row of the art. Split into runs so the ring, the mark's face and
 * its depth each carry their own colour; the glyph ramp underneath still
 * encodes the same thing, which is what keeps it readable with colour
 * stripped.
 */
function ArtRow({ row }: { row: string }): ReactElement {
  const runs: { text: string; kind: "face" | "depth" | "ring" }[] = [];
  for (const glyph of row) {
    const kind =
      glyph === ORBIT_GLYPH ? "ring" : FACE_GLYPHS.has(glyph) ? "face" : "depth";
    const last = runs[runs.length - 1];
    if (last && last.kind === kind) last.text += glyph;
    else runs.push({ text: glyph, kind });
  }
  return (
    <Text wrap="truncate">
      {runs.map((run, index) => (
        <Text
          key={index}
          bold={run.kind !== "ring"}
          color={
            run.kind === "ring"
              ? theme.colors.accentSoft
              : run.kind === "face"
                ? theme.colors.brandFace
                : theme.colors.brandMark
          }
        >
          {run.text}
        </Text>
      ))}
    </Text>
  );
}
