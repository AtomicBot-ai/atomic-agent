import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../../theme/theme.js";
import type { PrivacyPanelState } from "../privacy-panel-state.js";

export interface PrivacyPanelProps {
  panel: PrivacyPanelState;
}

/**
 * The Privacy tab surfaces what data (if any) leaves the machine. Today
 * it hosts a single control: the anonymous-analytics opt-out (shared by
 * product analytics and crash reporting). The toggle applies live — no
 * restart.
 */
export function PrivacyPanel({ panel }: PrivacyPanelProps): ReactElement {
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color={theme.colors.accentSoft}>
          Analytics
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.colors.muted}>{"   "}anonymous usage </Text>
        <Text
          color={
            panel.analyticsEnabled
              ? theme.colors.accentSoft
              : theme.colors.muted
          }
        >
          {panel.analyticsEnabled ? "on" : "off"}
        </Text>
        {panel.busy ? (
          <Text color={theme.colors.muted}>{"  "}…</Text>
        ) : null}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.colors.muted}>
          {"   "}Product analytics + crash reports, fully anonymous. No
          message content, paths, args, or IP ever leave this machine —
          only an install id and coarse counters.
        </Text>
      </Box>
      {panel.message ? (
        <Box marginTop={1}>
          <Text color={theme.colors.accentSoft}>{"   "}{panel.message}</Text>
        </Box>
      ) : null}
      {panel.lastError ? (
        <Box marginTop={1}>
          <Text color={theme.colors.error}>{"   "}{panel.lastError}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color={theme.colors.muted}>
          a — {panel.analyticsEnabled ? "disable" : "enable"} · r — refresh
        </Text>
      </Box>
    </Box>
  );
}
