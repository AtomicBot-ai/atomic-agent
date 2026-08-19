import { Text } from "ink";
import type { ReactElement } from "react";

import { theme } from "../theme/theme.js";
import { RUN_MODES } from "../run-mode/run-mode-nav.js";
import { runModePillLabel } from "../run-mode/run-mode-selectors.js";
import type { RunModePanelState } from "../run-mode/run-mode-panel-state.js";

export interface RunModeBarProps {
  panel: RunModePanelState;
}

/**
 * The Run section's submenu: a one-row pill strip reading
 * `▸ Local · Cloud · Fusion 40%`, rendered directly under the status bar
 * while the chat surface is showing.
 *
 * It is a new row rather than `DebugPane`'s `SubTabBar` because that
 * component only renders in debug mode — its `section === "run"` branch
 * is unreachable. And it is a persistent strip rather than an overlay
 * because a run mode is a state you are IN: an operator has to be able
 * to see at a glance whether the next turn spends cloud tokens.
 */
export function RunModeBar({ panel }: RunModeBarProps): ReactElement {
  return (
    <Text>
      {RUN_MODES.map((mode, idx) => {
        const active = mode === panel.effective;
        return (
          <Text key={mode}>
            <Text
              color={active ? theme.colors.accentSoft : theme.colors.muted}
              bold={active}
            >
              {active ? `${theme.glyphs.chevronRight} ` : "  "}
              {runModePillLabel(mode, panel)}
            </Text>
            {idx < RUN_MODES.length - 1 ? (
              <Text color={theme.colors.muted}>
                {"  "}
                {theme.glyphs.dotSeparator}
                {"  "}
              </Text>
            ) : null}
          </Text>
        );
      })}
      {panel.lastError ? (
        <Text color={theme.colors.error}>
          {"  "}
          {theme.glyphs.pipeSeparator} {panel.lastError}
        </Text>
      ) : null}
    </Text>
  );
}
