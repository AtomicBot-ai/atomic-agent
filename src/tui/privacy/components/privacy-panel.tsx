import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { formatApprovalCategory } from "../../../approval/approval-level.js";
import type { SessionGrantsSnapshot } from "../../../approval/approval-gate.js";
import { theme } from "../../theme/theme.js";
import type { PrivacyPanelState } from "../privacy-panel-state.js";

export interface PrivacyPanelProps {
  panel: PrivacyPanelState;
}

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
          Session grants
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {sessionGrantLines(panel.sessionGrants).map((line) => (
          <Text key={line} color={theme.colors.muted}>
            {"   "}{line}
          </Text>
        ))}
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
          a: analytics {panel.analyticsEnabled ? "off" : "on"} · r: refresh
        </Text>
      </Box>
    </Box>
  );
}

/**
 * Read-only summary of the active session's point grants (`[s]` / `[a]`
 * in the approval prompt). In-memory, cleared when the session is
 * switched / restarted, never persisted — spelled out so the operator can
 * see what is currently allowed without waiting for a prompt to go silent.
 */
function sessionGrantLines(grants: SessionGrantsSnapshot): string[] {
  const { categories, shapes } = grants;
  if (categories.length === 0 && shapes.length === 0) {
    return [
      "none active — grants you make with [s] / [a] at a prompt appear here for this session",
    ];
  }
  const lines: string[] = [];
  if (categories.length > 0) {
    lines.push(
      `categories: ${categories.map(formatApprovalCategory).join(", ")}`,
    );
  }
  if (shapes.length > 0) {
    lines.push(`shell commands: ${shapes.join(", ")}`);
  }
  lines.push("cleared when you switch or start a session; never persisted");
  return lines;
}
