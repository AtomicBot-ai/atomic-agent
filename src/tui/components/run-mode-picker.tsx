import { Box, Text } from "ink";
import type { ReactElement } from "react";

import { theme } from "../theme/theme.js";
import { RUN_MODES, RUN_MODE_LABELS } from "../run-mode/run-mode-nav.js";
import {
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
      {RUN_MODES.map((mode, idx) => {
        const selected = idx === picker.cursor;
        return (
          <Text
            key={mode}
            color={selected ? theme.colors.accentSoft : theme.colors.muted}
            bold={selected}
          >
            {selected ? `${theme.glyphs.chevronRight} ` : "  "}
            {RUN_MODE_LABELS[mode]}
            <Text color={theme.colors.muted}> — {MODE_BLURBS[mode]}</Text>
            {mode === panel.effective ? (
              <Text color={theme.colors.muted}> (current)</Text>
            ) : null}
          </Text>
        );
      })}
      <Text color={fusionSelected ? theme.colors.accentSoft : theme.colors.muted}>
        {"  "}
        cloud share {String(picker.draftCloudShare).padStart(3, " ")}%{"  "}
        {formatCloudShareBar(picker.draftCloudShare)}
      </Text>
      <Text color={theme.colors.muted}>
        {"  "}
        {fusionSelected
          ? describeCloudShare(picker.draftCloudShare)
          : "the dial only applies to Fusion"}
      </Text>
      {panel.degradedMessage ? (
        <Text color={theme.colors.warn}>{panel.degradedMessage}</Text>
      ) : null}
      <Text color={theme.colors.muted}>
        ↑↓ mode · ←→ share (shift ±25) · digits set · enter apply · esc cancel
      </Text>
    </Box>
  );
}
