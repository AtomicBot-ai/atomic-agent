import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { formatElapsed, useElapsed } from "../hooks/use-elapsed.js";
import { useSpinner } from "../hooks/use-spinner.js";
import { theme } from "../theme/theme.js";
import type { TuiState } from "../tui-state.js";
import { pickWaitingPhrase } from "../waiting-phrases.js";

interface StatusLineProps {
  state: TuiState;
}

/**
 * Single-row live status. Busy state (running / awaiting approval) shows
 * a spinner, a rotating waiting phrase, and the live elapsed counter.
 * Idle state reduces to a muted summary of the last run outcome — the
 * line still occupies one row so the layout never jumps.
 */
export function StatusLine({ state }: StatusLineProps): ReactElement {
  const busy =
    state.status === "running" || state.status === "awaiting_approval";
  const elapsedMs = useElapsed(state.runStartedAt, 1000);
  const spinner = useSpinner(busy);
  if (!busy) {
    const text = state.lastRunStatus ?? "idle";
    return (
      <Box>
        <Text color={theme.colors.muted}>
          {theme.glyphs.dotSeparator} {text}
        </Text>
      </Box>
    );
  }
  const phrase = resolvePhrase(state);
  const stepLabel = state.currentStep > 0
    ? `step ${state.currentStep}/${state.session.maxSteps}`
    : "step …";
  return (
    <Box>
      <Text color={theme.colors.accent}>{spinner}</Text>
      <Text> </Text>
      <Text color={theme.colors.accentSoft} bold>
        {phrase}
      </Text>
      <Text color={theme.colors.muted}>
        {" "}
        {theme.glyphs.dotSeparator} {formatElapsed(elapsedMs)}
        {" "}
        {theme.glyphs.pipeSeparator} {stepLabel}
      </Text>
      {state.aborting ? (
        <Text color={theme.colors.warn}>
          {" "}
          {theme.glyphs.pipeSeparator} aborting
        </Text>
      ) : null}
    </Box>
  );
}

function resolvePhrase(state: TuiState): string {
  if (state.status === "awaiting_approval") return "awaiting approval";
  if (state.aborting) return "aborting";
  if (state.streamingAssistantText !== null) return "streaming";
  const seed = state.runStartedAt ?? 0;
  return pickWaitingPhrase(seed);
}
