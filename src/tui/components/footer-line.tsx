import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import type { LlmHealthState } from "../llm-health/llm-health-state.js";
import type { TuiState } from "../tui-state.js";

interface FooterLineProps {
  state: TuiState;
}

/**
 * Single-row metadata footer: llama-server health indicator, session id,
 * tokens in/out, tool counters and any flags in effect. Rendered in muted
 * colour to stay behind the main chat content while remaining scannable.
 *
 * The `llm` segment is always first so the daemon status is visible in
 * every mode (chat, debug, logs) without depending on the Models tab
 * refresh cadence — see `LlmHealthPoller` for the probe loop.
 */
export function FooterLine({ state }: FooterLineProps): ReactElement {
  const textParts = buildParts(state);
  const separator = ` ${theme.glyphs.pipeSeparator} `;
  return (
    <Box>
      <LlmHealthBadge health={state.llmHealth} />
      <Text color={theme.colors.muted}>
        {separator}
        {textParts.join(separator)}
      </Text>
    </Box>
  );
}

interface LlmHealthBadgeProps {
  health: LlmHealthState;
}

/**
 * Colour + glyph + short label for the always-on llama-server probe:
 * - ● healthy (green) — last probe returned 2xx; latency appended
 * - ◐ probing (yellow) — probe in flight, no confirmed state yet
 * - ○ down (gray) — last probe could not reach the server
 * - ✕ error (red) — unexpected failure in the probe path
 * - · unknown (gray) — no probe has completed yet
 */
function LlmHealthBadge({ health }: LlmHealthBadgeProps): ReactElement {
  const { color, glyph, label } = resolveBadge(health);
  return (
    <Text>
      <Text color={color} bold>
        {glyph}
      </Text>
      <Text color={theme.colors.muted}> llm </Text>
      <Text color={color}>{label}</Text>
    </Text>
  );
}

interface BadgeLook {
  color: string;
  glyph: string;
  label: string;
}

function resolveBadge(health: LlmHealthState): BadgeLook {
  switch (health.status) {
    case "healthy": {
      const latency = health.latencyMs !== null ? `${health.latencyMs}ms` : "ok";
      return { color: theme.colors.success, glyph: "●", label: latency };
    }
    case "probing":
      return { color: theme.colors.warn, glyph: "◐", label: "probing" };
    case "unreachable":
      return { color: theme.colors.muted, glyph: "○", label: "down" };
    case "error":
      return { color: theme.colors.error, glyph: "✕", label: "error" };
    case "unknown":
    default:
      return { color: theme.colors.muted, glyph: "·", label: "unknown" };
  }
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
