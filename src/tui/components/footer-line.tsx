import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import type { TuiState } from "../tui-state.js";

interface FooterLineProps {
  state: TuiState;
}

/**
 * Single-row metadata footer: session id, tokens in/out, tool counters
 * and any flags in effect. Rendered in muted colour to stay behind the
 * main chat content while remaining scannable.
 */
export function FooterLine({ state }: FooterLineProps): ReactElement {
  const parts = buildParts(state);
  return (
    <Box>
      <Text color={theme.colors.muted}>
        {parts.join(` ${theme.glyphs.pipeSeparator} `)}
      </Text>
    </Box>
  );
}

function buildParts(state: TuiState): string[] {
  const { session, metrics } = state;
  const tokens = `${formatNumber(metrics.promptTokensLast)}p/${formatNumber(
    metrics.completionTokensLast,
  )}c · total ${metrics.totalTokens}`;
  const tools = `tools ${metrics.toolsOk}ok/${metrics.toolsError}err`;
  const kvTotal = metrics.kvCacheHits + metrics.kvCacheMisses;
  const kv =
    kvTotal === 0
      ? "kv —"
      : `kv ${Math.round((metrics.kvCacheHits / kvTotal) * 100)}%`;
  const latency = formatLatency(metrics.llmDurationMsLast, metrics.stepDurationMsLast);
  return [
    `session ${session.sessionId ? shortId(session.sessionId) : "(pending)"}`,
    `model ${shortUrl(session.llamaUrl)}`,
    tokens,
    latency,
    kv,
    tools,
    session.approvalRequired ? "approval on" : "approval off",
  ];
}

function formatNumber(value: number | null): string {
  if (value === null) return "—";
  if (value < 1000) return String(value);
  return `${(value / 1000).toFixed(1)}k`;
}

function formatLatency(llmMs: number | null, stepMs: number | null): string {
  const llm = llmMs === null ? "—" : `${llmMs}ms`;
  const step = stepMs === null ? "—" : `${stepMs}ms`;
  return `llm ${llm} · step ${step}`;
}

function shortId(id: string): string {
  if (id.length <= 8) return id;
  return `${id.slice(0, 8)}…`;
}

function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, "");
}
