import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import type { TuiState } from "../tui-state.js";
import {
  selectLlmActiveRouteSummary,
  selectLlmPanelRows,
} from "../llm-panel/llm-panel-selectors.js";
import { LlmModeRows } from "./llm-mode-rows.js";
import { LlmPanelModals } from "./llm-panel-modals.js";

export function LlmPanel({ state }: { state: TuiState }): ReactElement {
  const rows = selectLlmPanelRows(state);
  const summary = selectLlmActiveRouteSummary(state);
  return (
    <Box flexDirection="column" width="100%">
      <LlmPanelModals state={state} />
      <RouteCard state={state} summary={summary} />
      <ModeHeader mode={state.llmPanel.mode} />
      <StatusLines state={state} />
      <Box flexDirection="column">
        <LlmModeRows rows={rows} state={state} />
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.colors.muted}>
          j/k move · Enter selected action · ←/→ switch Local/Cloud · n add provider · c configure · r refresh
        </Text>
      </Box>
    </Box>
  );
}

function RouteCard({
  state,
  summary,
}: {
  state: TuiState;
  summary: ReturnType<typeof selectLlmActiveRouteSummary>;
}): ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={theme.colors.accentSoft}>
        Active chat route
      </Text>
      <Text>
        current:{" "}
        <Text bold color={theme.colors.accentSoft}>
          {summary.providerLabel}
        </Text>
        {summary.textModel ? (
          <Text color={theme.colors.muted}> / {summary.textModel}</Text>
        ) : null}
      </Text>
      <Text color={theme.colors.muted}>
        tools {summary.toolTransportLabel} · cache {summary.cacheLabel}
      </Text>
      <Text color={theme.colors.muted}>
        provider embeddings:{" "}
        {summary.activeEmbeddingProvider
          ? `${summary.activeEmbeddingProvider.id}${
              summary.activeEmbeddingProvider.embeddingModel
                ? ` · ${summary.activeEmbeddingProvider.embeddingModel}`
                : ""
            }`
          : "not configured"}
      </Text>
      <Text color={theme.colors.muted}>
        local daemon: {formatDaemon(state)} · mode {state.localModelsPanel.configMode}
        {state.localModelsPanel.configMode === "external"
          ? ` · ${state.session.llamaUrl}`
          : ""}
      </Text>
    </Box>
  );
}

function ModeHeader({ mode }: { mode: "local" | "cloud" }): ReactElement {
  const switchHint =
    mode === "local" ? "Press → to switch to Cloud" : "Press ← to switch to Local";
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        Mode:{" "}
        <Text bold color={mode === "local" ? theme.colors.accentSoft : theme.colors.muted}>
          Local
        </Text>
        <Text color={theme.colors.muted}> | </Text>
        <Text bold color={mode === "cloud" ? theme.colors.accentSoft : theme.colors.muted}>
          Cloud
        </Text>
      </Text>
      <Text color={theme.colors.muted}>{switchHint}</Text>
    </Box>
  );
}

function StatusLines({ state }: { state: TuiState }): ReactElement | null {
  const lines: string[] = [];
  if (state.llmPanel.mode === "local") {
    if (state.localModelsPanel.loading) lines.push("local catalog: loading");
    if (state.localModelsPanel.errorLine) {
      lines.push(`local catalog: ${state.localModelsPanel.errorLine}`);
    }
    if (state.localModelsPanel.daemonError) {
      lines.push(`local daemon: ${state.localModelsPanel.daemonError}`);
    }
  } else {
    if (state.providersPanel.busy) lines.push("cloud providers: updating");
    if (state.providersPanel.statusLine) {
      lines.push(`cloud providers: ${state.providersPanel.statusLine}`);
    }
  }
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={theme.colors.muted}>{lines[0] ?? "status: ready"}</Text>
    </Box>
  );
}

function formatDaemon(state: TuiState): string {
  const panel = state.localModelsPanel;
  if (panel.daemonPhase === "starting") return "starting";
  if (panel.daemonPhase === "stopping") return "stopping";
  if (!panel.daemon.running) return "stopped";
  if (panel.daemon.loading) return `loading pid ${panel.daemon.pid}`;
  if (panel.daemon.healthy) {
    return `running pid ${panel.daemon.pid} on 127.0.0.1:${panel.daemon.port}`;
  }
  return `pid ${panel.daemon.pid} health unreachable`;
}

