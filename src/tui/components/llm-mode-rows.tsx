import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { activeCursor, selectLlmPanelRows, type LlmPanelRow } from "../llm-panel/llm-panel-selectors.js";
import { theme } from "../theme/theme.js";
import type { TuiState } from "../tui-state.js";

export function LlmModeRows({
  rows,
  state,
}: {
  rows: readonly LlmPanelRow[];
  state: TuiState;
}): ReactElement {
  return state.llmPanel.mode === "local" ? (
    <LocalRows rows={rows} state={state} />
  ) : (
    <CloudRows rows={rows} state={state} />
  );
}

function LocalRows({
  rows,
  state,
}: {
  rows: readonly LlmPanelRow[];
  state: TuiState;
}): ReactElement {
  const textRows = rows.filter((row) => row.kind === "localTextModel");
  const embeddingRows = rows.filter((row) => row.kind === "localEmbeddingModel");
  return (
    <Box flexDirection="column">
      <RowsSection title="Local text models" rows={textRows} state={state} />
      <RowsSection title="Local embeddings" rows={embeddingRows} state={state} />
    </Box>
  );
}

function CloudRows({
  rows,
  state,
}: {
  rows: readonly LlmPanelRow[];
  state: TuiState;
}): ReactElement {
  const providerRows = rows.filter((row) => row.kind === "cloudProvider");
  const textRows = rows.filter((row) => row.kind === "cloudChatModel");
  const embeddingRows = rows.filter((row) => row.kind === "cloudEmbeddingModel");
  return (
    <Box flexDirection="column">
      <RowsSection
        title="Cloud providers"
        rows={providerRows}
        state={state}
        empty="No cloud providers configured. Press n to add one."
      />
      <RowsSection title="Cloud text models" rows={textRows} state={state} />
      <RowsSection title="Cloud embeddings" rows={embeddingRows} state={state} />
    </Box>
  );
}

function RowsSection({
  title,
  rows,
  state,
  empty = "No rows in this section yet.",
}: {
  title: string;
  rows: readonly LlmPanelRow[];
  state: TuiState;
  empty?: string;
}): ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={theme.colors.accentSoft}>
        {title}
      </Text>
      {rows.length === 0 ? (
        <Text color={theme.colors.muted}>  {empty}</Text>
      ) : (
        rows.map((row) => <Row key={row.id} row={row} state={state} />)
      )}
    </Box>
  );
}

function Row({ row, state }: { row: LlmPanelRow; state: TuiState }): ReactElement {
  const rows = selectLlmPanelRows(state);
  const idx = rows.findIndex((candidate) => candidate.id === row.id);
  const selected = idx === activeCursor(state);
  const mark = "active" in row && row.active ? "*" : selected ? ">" : " ";
  return (
    <Text color={selected ? theme.colors.accentSoft : undefined} bold={selected}>
      {mark} {renderRowText(row, state)}
      <Text color={theme.colors.muted}> · {row.enterEffect}</Text>
    </Text>
  );
}

function renderRowText(row: LlmPanelRow, state: TuiState): string {
  switch (row.kind) {
    case "localTextModel":
      return `${row.model.id} ${row.model.def.sizeLabel} [${localModelStatus(row.model)}]`;
    case "localEmbeddingModel":
      return `${row.model.id} ${row.model.def.sizeLabel} [${row.model.downloaded ? "downloaded" : "remote"}]`;
    case "localDaemon":
      return `llama.cpp daemon [${formatDaemon(state)}]`;
    case "localBackend":
      return `llama.cpp backend [${state.localModelsPanel.backend.currentTag ?? "not installed"}]`;
    case "cloudProvider":
      return `${row.provider.id} [${row.provider.kind}] ${row.provider.hasApiKey ? "key ok" : "missing key"}`;
    case "cloudChatModel":
      return `${row.providerId}/${row.modelId} [text]`;
    case "cloudEmbeddingModel":
      return `${row.providerId}/${row.modelId} [embedding]`;
  }
}

function localModelStatus(model: Extract<LlmPanelRow, { kind: "localTextModel" }>["model"]): string {
  if (!model.downloaded) return "remote";
  if (model.def.supportsVision && model.mmprojStatus === "missing") return "gguf, mmproj missing";
  if (model.def.supportsVision) return "gguf+mmproj";
  return "downloaded";
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
