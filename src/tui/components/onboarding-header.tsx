import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import { CROSS_MARKS } from "./logo-art.js";

const FACE_GLYPHS = new Set(["#", "█"]);

/**
 * Brand lockup for the first-run screens: the small mark, the product
 * name, and where in the flow the operator is. Deliberately not the
 * `StatusBar` — during setup there is no session, no breadcrumb and no
 * tab to name, and borrowing the app's chrome would advertise
 * navigation that does not exist yet.
 */
export function OnboardingHeader(props: {
  subtitle: string;
  mark?: boolean;
}): ReactElement {
  const rows = CROSS_MARKS.block.sm;
  if (props.mark === false) {
    return (
      <Box flexDirection="column" flexShrink={0}>
        <Text bold color={theme.colors.accent}>
          atomic
        </Text>
        <Text color={theme.colors.muted}>{props.subtitle}</Text>
      </Box>
    );
  }
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
