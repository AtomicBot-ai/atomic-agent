import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import type { TuiState } from "../tui-state.js";

interface DebugDiagnosticsLineProps {
  state: TuiState;
}

/**
 * Second-row context for Observe/Manage: fields removed from the global
 * status bar (cwd, llama URL, KV cache hit rate, tool counters, approval
 * flag) so Run stays quiet. Rendered only while `uiMode === "debug"`.
 */
export function DebugDiagnosticsLine({
  state,
}: DebugDiagnosticsLineProps): ReactElement {
  const { session, metrics } = state;
  const tools = `tools ${metrics.toolsOk}ok/${metrics.toolsError}err`;
  const kvTotal = metrics.kvCacheHits + metrics.kvCacheMisses;
  const kv =
    kvTotal === 0
      ? "kv —"
      : `kv ${Math.round((metrics.kvCacheHits / kvTotal) * 100)}%`;
  const latency = formatLatency(metrics.llmDurationMsLast, metrics.stepDurationMsLast);
  const line = [
    `cwd ${shortenPath(session.workingDir)}`,
    `llama ${session.llamaUrl}`,
    latency,
    kv,
    tools,
    session.approvalRequired ? "approval on" : "approval off",
    `skills ${session.skillCount}`,
  ].join(` ${theme.glyphs.pipeSeparator} `);

  return (
    <Box marginTop={0}>
      <Text color={theme.colors.muted}>{line}</Text>
    </Box>
  );
}

function formatLatency(llmMs: number | null, stepMs: number | null): string {
  const llm = llmMs === null ? "—" : `${llmMs}ms`;
  const step = stepMs === null ? "—" : `${stepMs}ms`;
  return `llm ${llm} · step ${step}`;
}

function shortenPath(value: string): string {
  const home = process.env.HOME;
  if (home && value.startsWith(home)) return `~${value.slice(home.length)}`;
  return value;
}
