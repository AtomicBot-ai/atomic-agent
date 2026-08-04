import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { activeCursor, selectLlmPanelRows, type LlmPanelRow } from "../llm-panel/llm-panel-selectors.js";
import { classifyRamFit, classifyVramFit } from "../local-models/local-models-panel-state.js";
import { computeRowWindow } from "../row-window.js";
import { theme } from "../theme/theme.js";
import type { TuiState } from "../tui-state.js";

export function LlmModeRows({
  rows,
  state,
  maxRows = 12,
}: {
  rows: readonly LlmPanelRow[];
  state: TuiState;
  maxRows?: number;
}): ReactElement {
  // When the catalog overflows the available height, switch to a
  // cursor-windowed flat view so the rendered frame never exceeds the
  // terminal (Ink overlaps/garbles lines when it does — it does NOT
  // clip). The full sectioned view also emits a header + bottom margin
  // per section, so the fit check must count that overhead, not just the
  // row count. Below the threshold we keep the richer sectioned view,
  // which also surfaces per-section empty hints.
  const sections = buildSections(rows);
  const fullViewHeight = rows.length + sections.length * 2;
  if (fullViewHeight > maxRows) {
    return <WindowedRows rows={rows} state={state} maxRows={maxRows} />;
  }
  if (state.llmPanel.mode === "local") return <LocalRows rows={rows} state={state} />;
  if (state.llmPanel.mode === "external") {
    return <ExternalRows rows={rows} state={state} />;
  }
  return <CloudRows rows={rows} state={state} />;
}

/** Human-readable section title for a row, used by the windowed view. */
function sectionTitle(kind: LlmPanelRow["kind"]): string {
  switch (kind) {
    case "localTextModel":
      return "Local text models";
    case "localEmbeddingModel":
      return "Local embeddings";
    case "cloudProvider":
      return "Cloud providers";
    case "cloudChatModel":
      return "Cloud text models";
    case "cloudEmbeddingModel":
      return "Cloud embeddings";
    case "localDaemon":
    case "localBackend":
      return "Local runtime";
    case "externalUrl":
      return "External llama.cpp";
  }
}

interface RowSection {
  title: string;
  /** Rows in this section paired with their index in the flat list. */
  items: { row: LlmPanelRow; index: number }[];
}

function buildSections(rows: readonly LlmPanelRow[]): RowSection[] {
  const sections: RowSection[] = [];
  rows.forEach((row, index) => {
    const title = sectionTitle(row.kind);
    const last = sections[sections.length - 1];
    if (last && last.title === title) {
      last.items.push({ row, index });
    } else {
      sections.push({ title, items: [{ row, index }] });
    }
  });
  return sections;
}

function WindowedRows({
  rows,
  state,
  maxRows,
}: {
  rows: readonly LlmPanelRow[];
  state: TuiState;
  maxRows: number;
}): ReactElement {
  const sections = buildSections(rows);
  const cursor = activeCursor(state);
  // Section headers and the ↑/↓ markers consume lines too, so the data
  // slice gets the remaining budget. Headers are ALWAYS rendered (even
  // for sections whose rows are currently scrolled out of view) so the
  // operator never loses the catalog structure on a small window.
  const dataBudget = Math.max(1, maxRows - sections.length - 2);
  const win = computeRowWindow(rows.length, cursor, dataBudget);
  const windowEnd = win.start + win.count;
  return (
    <Box flexDirection="column">
      {win.hiddenBefore > 0 ? (
        <Text color={theme.colors.muted}>↑ {win.hiddenBefore} above</Text>
      ) : null}
      {sections.map((section) => (
        <Box key={section.title} flexDirection="column">
          <Text bold color={theme.colors.accentSoft}>
            {section.title}
          </Text>
          {section.items
            .filter(({ index }) => index >= win.start && index < windowEnd)
            .map(({ row }) => (
              <Row key={row.id} row={row} state={state} />
            ))}
        </Box>
      ))}
      {win.hiddenAfter > 0 ? (
        <Text color={theme.colors.muted}>↓ {win.hiddenAfter} below</Text>
      ) : null}
    </Box>
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

/**
 * A llama-server the operator runs themselves is just a base URL, so the
 * pane is one row plus the hints that matter once you point at it: the
 * managed daemon keeps its VRAM until you stop it (`s`), and the Local
 * pane is where you go back to a managed model.
 */
function ExternalRows({
  rows,
  state,
}: {
  rows: readonly LlmPanelRow[];
  state: TuiState;
}): ReactElement {
  return (
    <Box flexDirection="column">
      <RowsSection title="External llama.cpp" rows={rows} state={state} />
      <Text color={theme.colors.muted}>
        {"  "}managed daemon: {formatDaemon(state)} · s start/stop
      </Text>
      <Text color={theme.colors.muted}>
        {"  "}← Local pane: pick a managed model to switch back
      </Text>
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
    case "externalUrl":
      return `base URL ${row.url} [${externalStatus(row.active, state)}]`;
  }
}

/**
 * Health only describes the *active* route, so an inactive external URL
 * reports "not active" rather than borrowing the managed daemon's probe.
 */
function externalStatus(active: boolean, state: TuiState): string {
  if (!active) return "not active";
  const { status, latencyMs } = state.llmHealth;
  return latencyMs === null ? status : `${status} · ${latencyMs}ms`;
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

