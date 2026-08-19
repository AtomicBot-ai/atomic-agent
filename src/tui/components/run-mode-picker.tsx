import { Box, Text } from "ink";
import type { ReactElement } from "react";

import { MouseTarget, useMouseCommands } from "../mouse/mouse-context.js";
import { isPrimaryPress } from "../mouse/mouse-event.js";
import { MOUSE_LAYER_MODAL } from "../mouse/mouse-registry.js";
import { openProviderSetupFromRunMode } from "../run-mode/run-mode-key-bindings.js";
import { theme } from "../theme/theme.js";
import { RUN_MODES, RUN_MODE_LABELS } from "../run-mode/run-mode-nav.js";
import {
  CLOUD_SHARE_BAR_WIDTH,
  describeCloudShare,
  formatCloudShareBar,
} from "../run-mode/run-mode-selectors.js";
import type { RunModePanelState } from "../run-mode/run-mode-panel-state.js";

export interface RunModePickerProps {
  panel: RunModePanelState;
}

const MODE_BLURBS: Record<string, string> = {
  local: "llama-server only",
  cloud: "cloud provider only",
  fusion: "cloud plans, local executes",
};

/**
 * Overlay for choosing a run mode and, for Fusion, the cloud share.
 *
 * The dial is why this exists at all: a 0-100 control cannot live in the
 * one-row strip. Everything here is a draft — Esc discards it and the
 * committed mode is untouched, the same contract `ThemePicker` offers.
 *
 * Mouse: a row click moves the cursor to that mode, and clicking the row
 * already under the cursor applies it — the two-step rule the rest of the
 * mouse layer uses for lists, because applying a mode swaps providers.
 * The dial is the exception: it is a slider, and clicking a slider at a
 * position means "put it here", so one click sets the share.
 */
export function RunModePicker({ panel }: RunModePickerProps): ReactElement | null {
  const picker = panel.picker;
  if (!picker) return null;
  const fusionSelected = picker.draftMode === "fusion";
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.colors.accentSoft}
      paddingX={1}
    >
      <Text color={theme.colors.accentSoft} bold>
        Run mode
      </Text>
      {RUN_MODES.map((mode, idx) => (
        <ModeRow
          key={mode}
          mode={mode}
          index={idx}
          selected={idx === picker.cursor}
          current={mode === panel.effective}
        />
      ))}
      <ShareDial
        cloudShare={picker.draftCloudShare}
        active={fusionSelected}
      />
      <Text color={theme.colors.muted}>
        {"  "}
        {fusionSelected
          ? describeCloudShare(picker.draftCloudShare)
          : "the dial only applies to Fusion"}
      </Text>
      {panel.degradedMessage ? (
        <Text color={theme.colors.warn}>{panel.degradedMessage}</Text>
      ) : null}
      {panel.cloudProviderMissing ? <SetUpProviderRow /> : null}
      <Text color={theme.colors.muted}>
        ↑↓ mode · ←→ share (shift ±25) · digits set · enter apply · esc cancel
      </Text>
    </Box>
  );
}

/**
 * On a fresh install two of the three modes cannot be entered at all,
 * and this overlay was where you found that out and then had nowhere to
 * go. The fix belongs on the screen that raises the problem.
 */
function SetUpProviderRow(): ReactElement {
  const mouse = useMouseCommands();
  const label = (
    <Text color={theme.colors.accent} bold>
      {"  "}
      {theme.glyphs.chevronRight} Set up a cloud provider…{" "}
      <Text color={theme.colors.muted}>(n)</Text>
    </Text>
  );
  if (!mouse) return label;
  return (
    <MouseTarget
      layer={MOUSE_LAYER_MODAL}
      onMouse={(hit) => {
        if (!isPrimaryPress(hit.event)) return false;
        openProviderSetupFromRunMode(mouse.dispatch);
        return true;
      }}
    >
      {label}
    </MouseTarget>
  );
}

function ModeRow({
  mode,
  index,
  selected,
  current,
}: {
  mode: (typeof RUN_MODES)[number];
  index: number;
  selected: boolean;
  current: boolean;
}): ReactElement {
  const mouse = useMouseCommands();
  const label = (
    <Text
      color={selected ? theme.colors.accentSoft : theme.colors.muted}
      bold={selected}
    >
      {selected ? `${theme.glyphs.chevronRight} ` : "  "}
      {RUN_MODE_LABELS[mode]}
      <Text color={theme.colors.muted}> — {MODE_BLURBS[mode]}</Text>
      {current ? <Text color={theme.colors.muted}> (current)</Text> : null}
    </Text>
  );
  if (!mouse) return label;
  return (
    <MouseTarget
      layer={MOUSE_LAYER_MODAL}
      onMouse={(hit) => {
        if (!isPrimaryPress(hit.event)) return false;
        if (selected) {
          const state = mouse.getState();
          const share = state.runModePanel.picker?.draftCloudShare;
          mouse.callbacks.onRunModeChangeRequested?.(mode, share);
          mouse.dispatch({ type: "run_mode_picker_closed" });
          return true;
        }
        mouse.dispatch({ type: "run_mode_picker_cursor_set", cursor: index });
        return true;
      }}
    >
      {label}
    </MouseTarget>
  );
}

/**
 * The 0-100 dial. Clicking column N of the bar sets the share to the
 * value that column represents, so the gesture matches what the bar
 * shows rather than nudging by a fixed step.
 */
function ShareDial({
  cloudShare,
  active,
}: {
  cloudShare: number;
  active: boolean;
}): ReactElement {
  const mouse = useMouseCommands();
  const label = (
    <Text color={active ? theme.colors.accentSoft : theme.colors.muted}>
      {"  "}
      cloud share {String(cloudShare).padStart(3, " ")}%{"  "}
      {formatCloudShareBar(cloudShare)}
    </Text>
  );
  if (!mouse) return label;
  // Columns before the bar: two spaces + "cloud share " + a 3-wide
  // percentage + "%" + two spaces.
  const barStartColumn = 2 + "cloud share ".length + 3 + 1 + 2;
  return (
    <MouseTarget
      layer={MOUSE_LAYER_MODAL}
      onMouse={(hit) => {
        if (!isPrimaryPress(hit.event)) return false;
        const column = hit.localX - barStartColumn;
        if (column < 0) return false;
        const share = Math.round(
          (Math.min(column, CLOUD_SHARE_BAR_WIDTH - 1) /
            (CLOUD_SHARE_BAR_WIDTH - 1)) *
            100,
        );
        mouse.dispatch({ type: "run_mode_picker_share_set", cloudShare: share });
        return true;
      }}
    >
      {label}
    </MouseTarget>
  );
}
