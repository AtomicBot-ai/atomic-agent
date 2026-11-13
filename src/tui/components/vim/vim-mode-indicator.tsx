import { Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../../theme/theme.js";
import type { VimMode } from "./vim-types.js";

/**
 * The composer's vim mode readout (ATO-662), drawn inside the field next
 * to Send while `/vim` is on. NORMAL is the one that needs noticing —
 * keys there are commands, not text — so it takes the accent; INSERT
 * stays quiet.
 */
export function VimModeIndicator({ mode }: { mode: VimMode }): ReactElement {
  return mode === "normal" ? (
    <Text color={theme.colors.accent} bold>
      NORMAL
    </Text>
  ) : (
    <Text color={theme.colors.muted}>INSERT</Text>
  );
}
