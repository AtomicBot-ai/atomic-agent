import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { formatBytes, formatEta, useTransferRate } from "../hooks/use-transfer-rate.js";
import type { LocalModelsPullState } from "../local-models/local-models-panel-state.js";
import { theme } from "../theme/theme.js";

const BAR_WIDTH = 36;

/**
 * A running local pull, drawn the same way wherever it appears.
 *
 * Two screens report the same download — the download step, and the
 * "almost there" screen that a mid-download cloud setup returns to — so
 * they share one component rather than each inventing its own summary.
 *
 * Two phases share one progress slot in state (the llama.cpp runtime
 * zip, then the weights), so the checklist is derived from which one is
 * currently reporting. Rate and ETA come from the same events: a
 * percentage cannot answer "how long", which is the question a
 * multi-gigabyte pull actually raises.
 */
export function OnboardingDownloadProgress(props: {
  pull: LocalModelsPullState | null;
}): ReactElement {
  const pull = props.pull;
  const { bytesPerSecond, etaSeconds } = useTransferRate(
    pull?.transferredBytes ?? 0,
    pull?.totalBytes ?? 0,
  );
  const phase = pull?.kind === "backend" ? "runtime" : "weights";

  return (
    <Box flexDirection="column" flexShrink={0}>
      <PhaseLine
        label="llama.cpp runtime"
        state={phase === "runtime" ? "active" : "done"}
        pull={phase === "runtime" ? pull : null}
      />
      <PhaseLine
        label="model weights"
        state={phase === "weights" ? "active" : "pending"}
        pull={phase === "weights" ? pull : null}
      />
      <Box marginTop={1}>
        {pull ? (
          <Text color={theme.colors.muted}>
            {bytesPerSecond ? `${formatBytes(bytesPerSecond)}/s · ` : ""}
            {formatEta(etaSeconds)}
          </Text>
        ) : (
          <Text color={theme.colors.muted}>starting…</Text>
        )}
      </Box>
      {pull?.error ? (
        <Box marginTop={1}>
          <Text color={theme.colors.error}>{pull.error}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function PhaseLine(props: {
  label: string;
  state: "active" | "done" | "pending";
  pull: LocalModelsPullState | null;
}): ReactElement {
  const percent = props.state === "done" ? 100 : (props.pull?.percent ?? 0);
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * BAR_WIDTH);
  const bar = "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
  const trailing =
    props.state === "done"
      ? "done"
      : props.pull
        ? `${Math.round(percent)}%   ${formatBytes(props.pull.transferredBytes)} / ${formatBytes(props.pull.totalBytes)}`
        : "waiting";
  return (
    <Text wrap="truncate">
      <Text color={theme.colors.muted}>{props.label.padEnd(20)}</Text>
      <Text color={props.state === "pending" ? theme.colors.border : theme.colors.accent}>
        {bar}
      </Text>
      <Text color={theme.colors.muted}>{`  ${trailing}`}</Text>
    </Text>
  );
}
