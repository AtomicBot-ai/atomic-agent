import { Box, Text } from "ink";
import type { ReactElement } from "react";
import {
  formatApprovalCategory,
  formatApprovalLevel,
  type ApprovalLevel,
} from "../../../approval/approval-level.js";
import type { SessionGrantsSnapshot } from "../../../approval/approval-gate.js";
import { theme } from "../../theme/theme.js";
import type { PrivacyPanelState } from "../privacy-panel-state.js";

export interface PrivacyPanelProps {
  panel: PrivacyPanelState;
}

/** One-line summary shown next to the level number. */
const LEVEL_SUMMARY: Record<ApprovalLevel, string> = {
  1: "every gated action asks first",
  2: "writes inside the project run without asking",
  3: "home-directory file changes and HTTP run without asking",
  4: "guarded shell, scripts, and process kills run without asking",
  5: "the agent runs every action without asking",
};

/**
 * Cumulative "what stops asking" list: the entry for level N and every
 * entry below it apply. Must never undersell the internal category
 * table in `approval-level.ts` — pinned by the panel test.
 */
const LEVEL_GRANTS: Record<ApprovalLevel, string> = {
  1: "asks for everything: shell commands, file writes and deletes, HTTP requests, process kills, script runs, browser navigation to non-web URLs (file://, javascript:)",
  2: "stops asking for file writes, edits, and patches strictly inside the project directory (symlinks pointing outside still ask)",
  3: "also stops asking for file writes anywhere in your home directory, moves to Trash, archive extraction, and HTTP requests (the SSRF guard stays on)",
  4: "also stops asking for shell commands the guard flags for approval, skill scripts, and process kills",
  5: "stops asking for everything, including browser navigation to non-web URLs (file://, javascript:)",
};

export function PrivacyPanel({ panel }: PrivacyPanelProps): ReactElement {
  const level = panel.approvalLevel;
  const fullTrust = level === 5;
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
        <Text color={theme.colors.muted}>{"   "}approval level </Text>
        <Text
          color={
            fullTrust
              ? theme.colors.error
              : level === 1
                ? theme.colors.muted
                : theme.colors.accentSoft
          }
        >
          {formatApprovalLevel(level)} · {LEVEL_SUMMARY[level]}
        </Text>
        {panel.busy ? (
          <Text color={theme.colors.muted}>{"  "}…</Text>
        ) : null}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {grantLines(level).map((line) => (
          <Text key={line} color={theme.colors.muted}>
            {"   "}{line}
          </Text>
        ))}
        {level < 5 ? (
          <Text color={theme.colors.muted}>
            {"   "}Writes to the agent's own config.json and .env always ask
            below level 5, so the agent cannot silently raise its own trust
            level.
          </Text>
        ) : null}
        <Text color={theme.colors.muted}>
          {"   "}Hardline guards still block catastrophic commands (rm -rf
          /, disk formats) at every level. Persists to config.json and
          applies to future runs too.
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
          1-5: set approval level · ←/→: adjust · a: analytics{" "}
          {panel.analyticsEnabled ? "off" : "on"} · r: refresh
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

/**
 * Levels 2..N accumulate; level 1 stands alone (nothing is silent) and
 * level 5 collapses the list to its single honest sentence.
 */
function grantLines(level: ApprovalLevel): string[] {
  if (level === 1) return [`This level ${LEVEL_GRANTS[1]}.`];
  if (level === 5) return [`This level ${LEVEL_GRANTS[5]}.`];
  const cumulative: ApprovalLevel[] = [2, 3, 4];
  return cumulative
    .filter((step) => step <= level)
    .map((step, index) =>
      index === 0
        ? `This level ${LEVEL_GRANTS[step]}.`
        : `It ${LEVEL_GRANTS[step]}.`,
    );
}
