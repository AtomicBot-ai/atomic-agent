import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { formatElapsed, useElapsed } from "../hooks/use-elapsed.js";
import { useSpinner } from "../hooks/use-spinner.js";
import type { LlmHealthState } from "../llm-health/llm-health-state.js";
import {
  getCurrentSection,
  SECTION_ORDER,
  type TuiSection,
} from "../section.js";
import { theme } from "../theme/theme.js";
import type { TuiState } from "../tui-state.js";
import { pickWaitingPhrase } from "../waiting-phrases.js";

interface StatusBarProps {
  state: TuiState;
}

/**
 * One-row operator status bar. Replaces the legacy `header-line` +
 * `status-line` + `footer-line` trio: only signal that needs to be
 * visible at every glance stays on screen — current section, LLM
 * health, turn status (or last outcome) and a short session id when
 * one exists. Verbose details (full cwd, llama URL, KV cache %, tools
 * ok/err counters, approval flag) move out of the always-visible
 * chrome and live in the Observe / Manage sections instead.
 */
export function StatusBar({ state }: StatusBarProps): ReactElement {
  const section = getCurrentSection(state);
  const busy =
    state.status === "running" || state.status === "awaiting_approval";
  const elapsedMs = useElapsed(busy ? state.runStartedAt : null, 1000);
  const spinner = useSpinner(busy);
  return (
    <Box>
      <Text color={theme.colors.accentSoft} bold>
        atomic-agent
      </Text>
      <Sep />
      <SectionPills active={section} />
      <Sep />
      <TurnStatus state={state} spinner={spinner} elapsedMs={elapsedMs} />
      <Sep />
      <HealthBadge health={state.llmHealth} />
      <SessionTag sessionId={state.session.sessionId} />
    </Box>
  );
}

const SECTION_LABELS: Record<TuiSection, string> = {
  run: "Run",
  observe: "Observe",
  manage: "Manage",
};

function SectionPills({ active }: { active: TuiSection }): ReactElement {
  return (
    <Text>
      {SECTION_ORDER.map((id, idx) => {
        const isActive = id === active;
        return (
          <Text key={id}>
            <Text
              color={isActive ? theme.colors.accentSoft : theme.colors.muted}
              bold={isActive}
            >
              {isActive ? `${theme.glyphs.chevronRight} ` : "  "}
              {SECTION_LABELS[id]}
            </Text>
            {idx < SECTION_ORDER.length - 1 ? (
              <Text color={theme.colors.muted}>
                {"  "}
                {theme.glyphs.dotSeparator}
                {"  "}
              </Text>
            ) : null}
          </Text>
        );
      })}
    </Text>
  );
}

interface TurnStatusProps {
  state: TuiState;
  spinner: string;
  elapsedMs: number | null;
}

function TurnStatus({
  state,
  spinner,
  elapsedMs,
}: TurnStatusProps): ReactElement {
  const busy =
    state.status === "running" || state.status === "awaiting_approval";
  if (!busy) {
    const text = state.lastRunStatus ?? "idle";
    return (
      <Text color={theme.colors.muted}>
        {theme.glyphs.dotSeparator} {text}
      </Text>
    );
  }
  const phrase = resolvePhrase(state);
  const stepLabel =
    state.currentStep > 0
      ? `step ${state.currentStep}/${state.session.maxSteps}`
      : "step …";
  return (
    <Text>
      <Text color={theme.colors.accent}>{spinner}</Text>
      <Text> </Text>
      <Text color={theme.colors.accentSoft} bold>
        {phrase}
      </Text>
      <Text color={theme.colors.muted}>
        {" "}
        {theme.glyphs.dotSeparator} {formatElapsed(elapsedMs)}{" "}
        {theme.glyphs.dotSeparator} {stepLabel}
      </Text>
      {state.aborting ? (
        <Text color={theme.colors.warn}>
          {" "}
          {theme.glyphs.dotSeparator} aborting
        </Text>
      ) : null}
    </Text>
  );
}

function resolvePhrase(state: TuiState): string {
  if (state.status === "awaiting_approval") return "awaiting approval";
  if (state.aborting) return "aborting";
  if (state.streamingAssistantText !== null) return "streaming";
  const seed = state.runStartedAt ?? 0;
  return pickWaitingPhrase(seed);
}

function HealthBadge({ health }: { health: LlmHealthState }): ReactElement {
  const { color, glyph, label } = resolveBadge(health);
  const model = formatModelLabel(health.model);
  return (
    <Text>
      <Text color={color} bold>
        {glyph}
      </Text>
      <Text color={theme.colors.muted}> llm</Text>
      {label ? <Text color={color}> {label}</Text> : null}
      {model ? (
        <Text>
          <Text color={theme.colors.muted}> {theme.glyphs.dotSeparator} </Text>
          <Text color={theme.colors.accentSoft}>{model}</Text>
        </Text>
      ) : null}
    </Text>
  );
}

const MODEL_LABEL_MAX_LEN = 32;

function formatModelLabel(model: string | null): string | null {
  if (!model) return null;
  const stripped = model.replace(/\.gguf$/i, "");
  if (stripped.length <= MODEL_LABEL_MAX_LEN) return stripped;
  return `${stripped.slice(0, MODEL_LABEL_MAX_LEN - 1)}…`;
}

interface BadgeLook {
  color: string;
  glyph: string;
  label: string;
}

function resolveBadge(health: LlmHealthState): BadgeLook {
  switch (health.status) {
    case "healthy":
      return { color: theme.colors.success, glyph: "●", label: "" };
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

interface SessionTagProps {
  sessionId: string | null;
}

function SessionTag({ sessionId }: SessionTagProps): ReactElement | null {
  if (!sessionId) return null;
  return (
    <Text>
      <Text color={theme.colors.muted}>
        {"  "}
        {theme.glyphs.dotSeparator} session{" "}
      </Text>
      <Text>{shortenId(sessionId)}</Text>
    </Text>
  );
}

function Sep(): ReactElement {
  return (
    <Text color={theme.colors.muted}>
      {"  "}
      {theme.glyphs.pipeSeparator}
      {"  "}
    </Text>
  );
}

function shortenId(value: string): string {
  if (value.length <= 8) return value;
  return `${value.slice(0, 8)}…`;
}
