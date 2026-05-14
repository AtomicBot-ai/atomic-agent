import { Box, Text } from "ink";
import { useEffect, useState, type ReactElement } from "react";
import { useSpinner } from "../hooks/use-spinner.js";
import { theme } from "../theme/theme.js";
import type { TuiState } from "../tui-state.js";

interface ThinkingIndicatorProps {
  state: TuiState;
}

/**
 * Surfaces what the agent is doing right now while the turn is in
 * flight. Three phases, in order of "we have something more to show":
 *
 *   1. **thinking** — no streaming tool calls, no streaming reply yet.
 *   2. **tool**     — at least one streaming tool call without a result.
 *      Surfaces tool name + the most identifying argument (path,
 *      command, query, …) so the operator can spot a stuck run.
 *   3. **reply**    — assistant text has started streaming. The
 *      indicator stays visible (collapsed to "writing reply") until
 *      the turn finalises so the spinner does not flicker on every
 *      delta.
 *
 * Always shows elapsed turn time so the operator can eyeball whether
 * something is stuck. Self-cleans when `state.status` flips out of
 * `running` (renders `null`).
 */
export function ThinkingIndicator({ state }: ThinkingIndicatorProps): ReactElement | null {
  const running = state.status === "running";
  const spinner = useSpinner(running);
  const elapsed = useElapsedSinceStart(state.runStartedAt, running);
  if (!running) return null;
  const phase = derivePhase(state);
  const elapsedLabel = formatElapsed(elapsed);
  const label = formatPhase(phase, elapsedLabel);
  return (
    <Box marginLeft={3} marginTop={1}>
      <Text color={theme.colors.assistant}>{spinner} </Text>
      <Text color={theme.colors.muted}>{label}</Text>
    </Box>
  );
}

type Phase =
  | { kind: "thinking" }
  | { kind: "tool"; tool: string; arg: string | null }
  | { kind: "reply" };

/**
 * Tools whose presence in `streamingToolCalls` means "reply is in
 * flight" rather than "a real tool is running". They are filtered out
 * of the indicator's tool-phase selection so the operator sees
 * `writing reply · …` (or just `thinking · …` if reply text has not
 * begun streaming yet) instead of `reply · …`. Mirrors the same set
 * used by `chat-log.tsx` to hide their cards from the surface.
 */
const HIDDEN_TOOL_NAMES: ReadonlySet<string> = new Set(["reply"]);

function derivePhase(state: TuiState): Phase {
  if (
    state.streamingAssistantText !== null &&
    state.streamingAssistantText.length > 0
  ) {
    return { kind: "reply" };
  }
  for (let i = state.streamingToolCalls.length - 1; i >= 0; i -= 1) {
    const call = state.streamingToolCalls[i];
    if (!call || HIDDEN_TOOL_NAMES.has(call.tool)) continue;
    return {
      kind: "tool",
      tool: call.tool,
      arg: extractIdentifyingArg(call.args),
    };
  }
  return { kind: "thinking" };
}

const PRIORITY_ARG_KEYS: readonly string[] = [
  "path",
  "filePath",
  "file",
  "command",
  "query",
  "pattern",
  "url",
  "name",
  "key",
];

function extractIdentifyingArg(args: Record<string, unknown>): string | null {
  for (const key of PRIORITY_ARG_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) {
      return truncate(value, 36);
    }
    if (typeof value === "number") {
      return String(value);
    }
  }
  return null;
}

function formatPhase(phase: Phase, elapsed: string): string {
  switch (phase.kind) {
    case "thinking":
      return `thinking · ${elapsed}`;
    case "tool":
      return phase.arg
        ? `${phase.tool} · ${phase.arg} · ${elapsed}`
        : `${phase.tool} · ${elapsed}`;
    case "reply":
      return `writing reply · ${elapsed}`;
  }
}

function useElapsedSinceStart(
  startedAt: number | null,
  active: boolean,
): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || startedAt === null) return;
    const handle = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(handle);
  }, [active, startedAt]);
  if (startedAt === null) return 0;
  return Math.max(0, now - startedAt);
}

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const restSec = seconds % 60;
  return `${minutes}m${restSec.toString().padStart(2, "0")}s`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
