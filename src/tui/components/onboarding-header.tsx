import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { OnboardingMark } from "../onboarding/onboarding-fit.js";
import { theme } from "../theme/theme.js";
import { CROSS_MARKS, FACE_GLYPHS } from "./logo-art.js";

/**
 * Brand lockup for the first-run screens: the mark, the product name,
 * and where in the flow the operator is. Deliberately not the
 * `StatusBar` — during setup there is no session, no breadcrumb and no
 * tab to name, and borrowing the app's chrome would advertise
 * navigation that does not exist yet.
 */
export function OnboardingHeader(props: {
  subtitle: string;
  /**
   * Which mark to draw, from the fit tiers. The minimal tier passes
   * `xs` rather than dropping the mark: the two-row sign costs no more
   * height than the bare text lockup it replaced, so even the tiniest
   * terminal keeps the brand.
   */
  mark?: OnboardingMark;
}): ReactElement {
  const rows = CROSS_MARKS.block[props.mark ?? "sm"];
  return (
    <Box flexDirection="row" flexShrink={0}>
      <Box flexDirection="column">
        {rows.map((row, i) => (
          <MarkRow key={i} row={row} />
        ))}
      </Box>
      <Box flexDirection="column" marginLeft={2} justifyContent="center">
        <Text bold color={theme.colors.accent}>
          atomic
        </Text>
        <Text color={theme.colors.muted}>{props.subtitle}</Text>
      </Box>
    </Box>
  );
}

/**
 * One row of the mark, split into face and depth runs so colour carries
 * the depth. The glyph ramp underneath (`█ ▓ ░`) still encodes it on its
 * own, which is what keeps the mark readable with colour stripped.
 */
function MarkRow({ row }: { row: string }): ReactElement {
  const runs: { text: string; face: boolean }[] = [];
  for (const ch of row) {
    const face = FACE_GLYPHS.has(ch);
    const last = runs[runs.length - 1];
    if (last && last.face === face) last.text += ch;
    else runs.push({ text: ch, face });
  }
  return (
    <Text wrap="truncate">
      {runs.map((run, i) => (
        <Text
          key={i}
          bold
          color={run.face ? theme.colors.brandFace : theme.colors.brandMark}
        >
          {run.text}
        </Text>
      ))}
    </Text>
  );
}
