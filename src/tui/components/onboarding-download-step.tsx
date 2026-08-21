import { Box, Text } from "ink";
import type { ReactElement } from "react";
import {
  formatBytes,
  formatEta,
  useTransferRate,
} from "../hooks/use-transfer-rate.js";
import type { LocalModelsPullState } from "../local-models/local-models-panel-state.js";
import { theme } from "../theme/theme.js";

const BAR_WIDTH = 36;

/**
 * The download, as its own screen.
 *
 * The panel's banner reports a percentage and a byte count; a
 * multi-gigabyte pull also raises "how long", which a percentage cannot
 * answer. Rate and ETA are derived here from the same progress events.
 *
 * Two phases share one progress slot in state — the llama.cpp runtime
 * zip, then the weights — so the checklist above the bar is derived from
 * which one is currently reporting.
 */
export function OnboardingDownloadStep(props: {
  pull: LocalModelsPullState | null;
  modelLabel: string;
}): ReactElement {
  const pull = props.pull;
  const { bytesPerSecond, etaSeconds } = useTransferRate(
    pull?.transferredBytes ?? 0,
    pull?.totalBytes ?? 0,
  );
  const phase = pull?.kind === "backend" ? "runtime" : "weights";

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text color={theme.colors.muted}>
        {`Downloading ${props.modelLabel}. You can leave this running.`}
      </Text>
      <Box marginTop={1} flexDirection="column">
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
      </Box>
      {pull ? (
        <Box marginTop={1}>
          <Text color={theme.colors.muted}>
            {bytesPerSecond ? `${formatBytes(bytesPerSecond)}/s · ` : ""}
            {formatEta(etaSeconds)}
          </Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text color={theme.colors.muted}>starting…</Text>
        </Box>
      )}
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
