import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { activeCursor, selectLlmPanelRows, type LlmPanelRow } from "../llm-panel/llm-panel-selectors.js";
import { classifyRamFit, classifyVramFit } from "../local-models/local-models-panel-state.js";
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
  // Fit badges for local text models. RAM fit is always computable
  // (host RAM is known up front), so it shows immediately — even before
  // anything is downloaded. VRAM fit needs a GPU budget that is only
  // available once the llama.cpp backend is on disk (Linux reads it from
  // `--list-devices`), so it stays silent until then. Both badges are
  // purely informational: the row is greyed but stays selectable and
  // downloadable. Each nested badge sets its own colour so it stays bright.
  const isLocalText = row.kind === "localTextModel";
  const ramFit = isLocalText
    ? classifyRamFit(row.model.def, state.localModelsPanel.totalRamGb)
    : null;
  const vramFit = isLocalText
    ? classifyVramFit(row.model.def, state.localModelsPanel.gpuBudgetGb)
    : null;
  const insufficient = ramFit === "insufficient" || vramFit === "insufficient";
  const baseColor = selected
    ? theme.colors.accentSoft
    : insufficient
      ? theme.colors.muted
      : undefined;
  return (
    <Text color={baseColor} bold={selected}>
      {mark} {renderRowText(row, state)}
      {insufficient ? (
        <Text color={theme.colors.warn}> Not enough VRAM</Text>
      ) : ramFit === "tight" ? (
        <Text color={theme.colors.warn}> RAM tight</Text>
      ) : null}
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
