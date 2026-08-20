import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { selectCloudModelSection } from "../llm-panel/llm-panel-row-builders.js";
import { activeCursor, selectLlmPanelRows, type LlmPanelRow } from "../llm-panel/llm-panel-selectors.js";
import { classifyRamFit, classifyVramFit } from "../local-models/local-models-panel-state.js";
import { computeRowWindow } from "../row-window.js";
import { MouseListRow, pressEnter } from "../mouse/mouse-list-row.js";
import { handleLlmPanelKey } from "../llm-panel/llm-panel-key-bindings.js";
import { theme } from "../theme/theme.js";
import type { TuiState } from "../tui-state.js";
import { FallbackRows } from "./llm-fallback-rows.js";
import { SUBSCRIPTION_CLI_KIND } from "../../config/provider-auth-mode.js";

export function LlmModeRows({
  rows,
  state,
  maxRows = 12,
}: {
  rows: readonly LlmPanelRow[];
  state: TuiState;
  maxRows?: number;
}): ReactElement {
  // The Fallback pane renders from `state.fallbackPanel`, not the shared
  // `LlmPanelRow` list, so it branches before everything else.
  if (state.llmPanel.mode === "fallback") {
    return <FallbackRows state={state} />;
  }
  // The Cloud pane windows its own model list (the catalog can be 350+
  // rows), so it never goes through the generic overflow fallback.
  if (state.llmPanel.mode === "cloud") {
    return <CloudRows rows={rows} state={state} maxRows={maxRows} />;
  }
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
  return <ExternalRows rows={rows} state={state} />;
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

/**
 * Preferred number of visible model rows in the inline list — matches
 * the window the modal picker used. Shrinks when the terminal budget
 * cannot afford it next to the provider/embedding sections.
 */
const MODEL_WINDOW = 12;

/**
 * Cloud pane: providers, then the inline filterable model list (full
 * catalog of the active provider, windowed around the cursor), then
 * embeddings. Replaces both the single static model row and the modal
 * picker this pane used to open.
 */
function CloudRows({
  rows,
  state,
  maxRows,
}: {
  rows: readonly LlmPanelRow[];
  state: TuiState;
  maxRows: number;
}): ReactElement {
  const providerRows = rows.filter((row) => row.kind === "cloudProvider");
  const textRows = rows.filter((row) => row.kind === "cloudChatModel");
  const embeddingRows = rows.filter((row) => row.kind === "cloudEmbeddingModel");
  const section = selectCloudModelSection(state);
  const filter = state.llmPanel.cloudModelFilter;
  const filterFocused = state.llmPanel.cloudModelFilterFocused;
  const statusLine = section.status !== "ready";
  // Everything around the model window costs lines: section headers (3),
  // their bottom margins (3), provider:/filter: (2), the counter (1),
  // provider/embedding rows, plus a loading/error line when shown.
  const overhead =
    9 +
    Math.max(1, providerRows.length) +
    Math.max(1, embeddingRows.length) +
    (statusLine ? 1 : 0);
  const windowSize = Math.max(3, Math.min(MODEL_WINDOW, maxRows - overhead));
  const cursorInSection = Math.max(
    0,
    Math.min(activeCursor(state) - section.sectionStart, textRows.length - 1),
  );
  const start = Math.max(
    0,
    Math.min(
      cursorInSection - Math.floor(windowSize / 2),
      textRows.length - windowSize,
    ),
  );
  const visible = textRows.slice(start, start + windowSize);
  const counter =
    textRows.length === 0
      ? "no match"
      : `${cursorInSection + 1}/${textRows.length}${
          textRows.length !== section.models.length
            ? ` of ${section.models.length}`
            : ""
        }`;
  return (
    <Box flexDirection="column">
      <RowsSection
        title="Cloud providers"
        rows={providerRows}
        state={state}
        empty="No cloud providers configured. Press n to add one."
        emphasiseEmpty
      />
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={theme.colors.accentSoft}>
          Cloud text models
        </Text>
        <Text color={theme.colors.muted}>
          {"provider: "}
          <Text bold color={theme.colors.accentSoft}>
            {section.provider?.id ?? "none"}
          </Text>
        </Text>
        <Text color={theme.colors.muted}>
          {"filter: "}
          <Text color={filterFocused ? theme.colors.accent : undefined}>
            {filter}
          </Text>
          {filterFocused ? <Text color={theme.colors.muted}>▏</Text> : null}
          {!filterFocused && filter.length === 0 ? (
            <Text color={theme.colors.muted}>f to filter</Text>
          ) : null}
        </Text>
        {section.status === "loading" ? (
          <Text color={theme.colors.muted}>  fetching model list…</Text>
        ) : null}
        {section.status === "error" ? (
          <Text color={theme.colors.error}>
            {"  "}model list unavailable ({section.error ?? "unknown error"}) -
            showing current model only
          </Text>
        ) : null}
        {visible.map((row) => (
          <Row key={row.id} row={row} state={state} />
        ))}
        <Text color={theme.colors.muted}>
          {"  "}↑/↓ move ({counter})
          {filterFocused ? " · type to filter · Enter select · Esc done" : ""}
        </Text>
      </Box>
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
  emphasiseEmpty = false,
}: {
  title: string;
  rows: readonly LlmPanelRow[];
  state: TuiState;
  empty?: string;
  /**
   * Render the empty hint bold in the terminal's default foreground instead of
   * muted grey. For an empty state that is really a call to action — the pane
   * is useless until you act on it — muted grey reads as "nothing to see here"
   * and the instruction gets skipped. Left unset elsewhere: a section that is
   * merely empty should stay quiet.
   */
  emphasiseEmpty?: boolean;
}): ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={theme.colors.accentSoft}>
        {title}
      </Text>
      {rows.length === 0 ? (
        <Text
          bold={emphasiseEmpty}
          color={emphasiseEmpty ? undefined : theme.colors.muted}
        >
          {"  "}
          {empty}
        </Text>
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
  // `wrap="truncate-end"` clips each row to the terminal width instead of
  // letting Ink wrap it. A wrapped row spills a second physical line that
  // Ink then overlaps with the following row (the whole panel already
  // switches to a windowed view to avoid the same overflow vertically —
  // see `LlmModeRows` — but never guarded the horizontal axis), which is
  // what garbles adjacent rows and drags rendering on a narrow window.
  return (
    <MouseListRow
      selected={selected}
      onSelect={(mouse) =>
        mouse.dispatch({ type: "llm_cursor_set", cursor: idx })
      }
      onActivate={pressEnter(handleLlmPanelKey)}
    >
      <Text color={baseColor} bold={selected} wrap="truncate-end">
        {mark} {renderRowText(row, state)}
        {insufficient ? (
          <Text color={theme.colors.warn}> Not enough VRAM</Text>
        ) : ramFit === "tight" ? (
          <Text color={theme.colors.warn}> RAM tight</Text>
        ) : null}
        <Text color={theme.colors.muted}> · {row.enterEffect}</Text>
      </Text>
    </MouseListRow>
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
      return `${row.provider.id} [${row.provider.kind}] ${
        row.provider.kind === SUBSCRIPTION_CLI_KIND
          ? "cli auth"
          : row.provider.hasApiKey
            ? "key ok"
            : "missing key"
      }`;
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

