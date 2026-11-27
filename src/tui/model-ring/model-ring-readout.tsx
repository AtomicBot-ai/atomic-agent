import { Text } from "ink";
import type { ReactElement } from "react";

import { fusionInk } from "../theme/fusion-tint.js";
import { theme } from "../theme/theme.js";
import type { TuiState } from "../tui-state.js";
import { selectModelRingReadout } from "./model-ring.js";

/**
 * The favourite's place in the composer bar (ATO-2500): ` · fav 2/3`
 * after the `/think` level, while the next turn runs on the second of
 * three favorites. Drawn only on the ring, muted like the readouts
 * beside it. `selectMetaBarFit` measures the same label.
 */
export function ModelRingReadout({
  state,
  fusion = false,
}: {
  state: TuiState;
  fusion?: boolean;
}): ReactElement | null {
  const label = selectModelRingReadout(state);
  if (label === null) return null;
  return (
    <Text color={fusion ? fusionInk() : theme.colors.railMuted}>{label}</Text>
  );
}
