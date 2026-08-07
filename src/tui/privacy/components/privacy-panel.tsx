import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../../theme/theme.js";
import type { PrivacyPanelState } from "../privacy-panel-state.js";

export interface PrivacyPanelProps {
  panel: PrivacyPanelState;
}

/**
 * The Privacy tab hosts the trust-and-safety switches: the
 * anonymous-analytics opt-out (shared by product analytics and crash
 * reporting) and the approve-everything toggle over the approval gate.
 * Both apply live — no restart — and persist to `config.json`.
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
      <Box marginTop={1}>
        <Text bold color={theme.colors.accentSoft}>
          Approvals
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.colors.muted}>{"   "}approve everything </Text>
        <Text
          color={
            panel.approveEverything ? theme.colors.error : theme.colors.muted
          }
        >
          {panel.approveEverything
            ? "on (the agent runs every action without asking)"
            : "off (risky actions ask for approval first)"}
        </Text>
        {panel.busy ? (
          <Text color={theme.colors.muted}>{"  "}…</Text>
        ) : null}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.colors.muted}>
          {"   "}Covers shell commands, file writes and deletes, HTTP
          requests, process kills, and script runs. Hardline guards still
          block catastrophic commands (rm -rf /, disk formats) either way.
          Persists to config.json and applies to future runs too.
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
          a — analytics {panel.analyticsEnabled ? "off" : "on"} · y — approve
          everything {panel.approveEverything ? "off" : "on"} · r — refresh
        </Text>
      </Box>
    </Box>
  );
}
