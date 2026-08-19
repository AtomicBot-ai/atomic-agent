import { Box, Text } from "ink";
import type { ReactElement } from "react";

import { MouseTarget, useMouseCommands } from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { theme } from "../theme/theme.js";
import { RUN_MODES } from "../run-mode/run-mode-nav.js";
import { runModePillLabel } from "../run-mode/run-mode-selectors.js";
import type { RunModePanelState } from "../run-mode/run-mode-panel-state.js";
import type { RunModeName } from "../../config/index.js";

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
 *
 * Each pill is its own `<Box>` rather than one flat `<Text>` run so the
 * mouse layer can measure it — the same shape the nav pills took in
 * #165. A visible control that cannot be clicked reads as broken once
 * every neighbouring control can be.
 */
export function RunModeBar({ panel }: RunModeBarProps): ReactElement {
  return (
    <Box flexWrap="wrap">
      {RUN_MODES.map((mode, idx) => (
        <Box key={mode} flexShrink={0}>
          <RunModePill mode={mode} panel={panel} />
          {idx < RUN_MODES.length - 1 ? (
            <Text color={theme.colors.muted}>
              {"  "}
              {theme.glyphs.dotSeparator}
              {"  "}
            </Text>
          ) : null}
        </Box>
      ))}
      {/*
        The strip showed three names and nothing else, so there was no
        way to learn it was a control at all — reported as "there is no
        hint anywhere how to switch them". Naming the key is cheap; the
        pills are clickable too.
      */}
      <Text color={theme.colors.muted}>
        {"   "}
        {theme.glyphs.pipeSeparator} ctrl+r or click · /run to configure
      </Text>
      {panel.lastError ? (
        <Text color={theme.colors.error}>
          {"  "}
          {theme.glyphs.pipeSeparator} {panel.lastError}
        </Text>
      ) : null}
    </Box>
  );
}

function RunModePill({
  mode,
  panel,
}: {
  mode: RunModeName;
  panel: RunModePanelState;
}): ReactElement {
  const mouse = useMouseCommands();
  const active = mode === panel.effective;
  const label = (
    <Text
      color={active ? theme.colors.accentSoft : theme.colors.muted}
      bold={active}
    >
      {active ? `${theme.glyphs.chevronRight} ` : "  "}
      {runModePillLabel(mode, panel)}
    </Text>
  );
  if (!mouse) return label;
  return (
    <MouseTarget
      onMouse={(hit) => {
        if (!isPrimaryPress(hit.event)) return false;
        // Clicking the mode already in effect opens the dial instead of
        // re-applying it: on Fusion that is the only way to reach the
        // cloud-share slider with the mouse, and re-applying a mode the
        // agent is already in would be a wasted provider swap.
        if (active) {
          mouse.dispatch({ type: "run_mode_picker_opened" });
          return true;
        }
        mouse.callbacks.onRunModeChangeRequested?.(mode);
        return true;
      }}
    >
      {label}
    </MouseTarget>
  );
}
