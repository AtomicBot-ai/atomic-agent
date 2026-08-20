import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { MouseListRow, pressEnter } from "../mouse/mouse-list-row.js";
import { handleLocalModelsTabKey } from "../local-models/local-models-key-bindings.js";
import { theme } from "../theme/theme.js";
import { computeRowWindow } from "../row-window.js";
import {
  classifyRamFit,
  classifyVramFit,
  estimateModelVramNeedGb,
  resolveRowAt,
  type EmbeddingDaemonInfo,
  type EmbeddingModelRow,
  type LocalModelRow,
  type LocalModelsPanelState,
  type RamFit,
} from "../local-models/local-models-panel-state.js";
import type { LocalModelDef } from "../../local-llm/index.js";

/**
 * Render the per-row availability badge that combines GGUF + mmproj
 * state into a single short label:
 * - `gguf+mm`  — vision-capable, both files on disk (ready for vision).
 * - `gguf, mm?`— vision-capable, GGUF on disk, projector missing.
 * - `gguf`     — text-only model, GGUF on disk; or vision row whose
 *                projector is somehow expected but not yet checked.
 * - `mm only`  — vision-capable, projector on disk but GGUF missing
 *                (rare; happens when the operator pulls projector
 *                before the weights).
 * - `remote`   — nothing on disk yet.
 *
 * Keeping the label short matters: the panel renders inside a single
 * Ink line, and longer text wraps awkwardly on narrow terminals.
 */
function renderRowAvailability(r: LocalModelRow): string {
  if (!r.def.supportsVision) {
    return r.downloaded ? "gguf" : "remote";
  }
  if (r.downloaded && r.mmprojStatus === "downloaded") return "gguf+mm";
  if (r.downloaded && r.mmprojStatus === "missing") return "gguf, mm?";
  if (!r.downloaded && r.mmprojStatus === "downloaded") return "mm only";
  return "remote";
}

interface DaemonStatusRender {
  glyph: string;
  color: string;
  label: string;
}

function renderDaemonStatus(panel: LocalModelsPanelState): DaemonStatusRender {
  if (panel.daemonPhase === "starting") {
    return { glyph: "⟳", color: "yellow", label: "starting…" };
  }
  if (panel.daemonPhase === "stopping") {
    return { glyph: "⟳", color: "yellow", label: "stopping…" };
  }
  const d = panel.daemon;
  if (!d.running) return { glyph: "✗", color: "red", label: "stopped" };
  if (d.loading) {
    return { glyph: "⟳", color: "yellow", label: `loading model (pid ${d.pid})` };
  }
  if (d.healthy) {
    return {
      glyph: "✓",
      color: "green",
      label: `running — pid ${d.pid} on 127.0.0.1:${d.port}`,
    };
  }
  return {
    glyph: "!",
    color: "yellow",
    label: `pid ${d.pid} alive but /health unreachable`,
  };
}

interface LocalModelsPanelProps {
  panel: LocalModelsPanelState;
  maxRows?: number;
}

/**
 * Rows consumed by the full status footer (top margin + mode line +
 * chat daemon + embedding daemon + data-dir + hotkey hint). Collapsed to
 * a 1-line daemon status + short hint when the window is short — Ink
 * garbles a frame taller than the terminal, it does not clip it.
 */
const FULL_FOOTER_ROWS = 7;
/** Rows consumed by the collapsed footer: daemon line + short hint. */
const COMPACT_FOOTER_ROWS = 3;
/** Minimum list rows we want before bothering to keep the full footer. */
const FULL_FOOTER_MIN_LIST = 5;

function formatDownloadBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function renderDaemonLine(panel: LocalModelsPanelState): ReactElement {
  const st = renderDaemonStatus(panel);
  return (
    <Text color={st.color} bold>
      daemon {st.glyph} {st.label}
    </Text>
  );
}

/**
 * Memory-v2 phase 1B. Embedding daemon status line. Separate from the
 * chat-daemon line because the two report independently: chat can be
 * up while embeddings are off, and vice versa.
 */
function renderEmbeddingDaemonLine(
  info: EmbeddingDaemonInfo | null,
): ReactElement {
  if (!info) {
    return (
      <Text color={theme.colors.muted}>embeddings ? (probing…)</Text>
    );
  }
  if (!info.enabled) {
    return (
      <Text color={theme.colors.muted}>
        embeddings ✗ disabled — FTS5-only recall
      </Text>
    );
  }
  if (!info.running) {
    const hint = info.activeModelId
      ? `stopped — *${info.activeModelId} selected — Enter on row or s to start`
      : "stopped — j/k + Enter on a row to select, then s";
    return <Text color="yellow">embeddings ⏸ {hint}</Text>;
  }
  if (info.loading) {
    return (
      <Text color="yellow">embeddings ⟳ loading (pid {info.pid})</Text>
    );
  }
  if (info.healthy) {
    const id = info.activeModelId ?? "?";
    return (
      <Text color="green" bold>
        embeddings ✓ running ({id}, pid {info.pid} on 127.0.0.1:
        {info.port})
      </Text>
    );
  }
  return (
    <Text color="yellow">
      embeddings ! pid {info.pid} alive but /health unreachable
    </Text>
  );
}

function renderProgressBar(percent: number, width: number): string {
  const filled = Math.min(width, Math.round((percent / 100) * width));
  return "=".repeat(filled) + " ".repeat(Math.max(0, width - filled));
}

function ramFitColor(fit: RamFit): string {
  switch (fit) {
    case "ok":
      return "green";
    case "tight":
      return "yellow";
    case "insufficient":
      return "red";
  }
}

function ramFitLabel(fit: RamFit, def: LocalModelDef): string {
  switch (fit) {
    case "ok":
      return `RAM ok (${def.recommendedRamGb}+ GB)`;
    case "tight":
      return `RAM tight (need ${def.recommendedRamGb} GB)`;
    case "insufficient":
      return `RAM low (need ${def.minRamGb} GB min)`;
  }
}

function DownloadBanners({ panel }: { panel: LocalModelsPanelState }): ReactElement | null {
  const pulls = [panel.pull, panel.embeddingPull].filter(
    (pull): pull is NonNullable<typeof pull> => pull !== null,
  );
  if (pulls.length === 0) return null;
  return (
    <Box flexDirection="column" marginBottom={1}>
      {pulls.map((pull) => (
        <DownloadBanner key={`${pull.kind}:${pull.modelId}`} pull={pull} />
      ))}
    </Box>
  );
}

function DownloadBanner({
  pull,
}: {
  pull: NonNullable<LocalModelsPanelState["pull"]>;
}): ReactElement {
  const w = 36;
  const bar = renderProgressBar(pull.percent, w);
  const total = pull.totalBytes > 0 ? pull.totalBytes : null;
  const xfer = formatDownloadBytes(pull.transferredBytes);
  const totalPart =
    total !== null ? ` / ${formatDownloadBytes(total)}` : "";
  const isModel = pull.modelId !== "_backend";
  const modelLine = isModel ? `model: ${pull.modelId}` : "target: backend zip";
  return (
    <Box flexDirection="column">
      <Text bold color={theme.colors.accentSoft}>
        downloading — {pull.label}
      </Text>
      <Text color={theme.colors.muted}>{modelLine}</Text>
      <Text>
        <Text color="yellow">[{bar}]</Text>{" "}
        <Text bold color="yellow">
          {pull.percent}%
        </Text>
        <Text color={theme.colors.muted}>
          {" "}
          {xfer}
          {totalPart}
        </Text>
      </Text>
    </Box>
  );
}

export function LocalModelsPanel({
  panel,
  maxRows = 12,
}: LocalModelsPanelProps): ReactElement {
  if (panel.mode === "backendUpdate") {
    return (
      <Box flexDirection="column">
        <Text color={theme.colors.muted}>backend update…</Text>
      </Box>
    );
  }
  if (panel.mode === "detail") {
    const ref = resolveRowAt(panel);
    // Detail view is chat-only — embedding rows are intentionally
    // text-only in the row list and have no extra info to surface.
    if (!ref || ref.kind !== "chat") {
      return <Text color={theme.colors.muted}>(no row)</Text>;
    }
    const row = ref.row;
    const m = row.def;
    // A pull for this very row is in flight: offering "Enter — download"
    // again is both wrong and re-triggerable.
    const rowPull =
      panel.pull &&
      !panel.pull.error &&
      panel.pull.kind === "chat" &&
      panel.pull.modelId === row.id
        ? panel.pull
        : null;
    const enterHint = rowPull
      ? rowPull.totalBytes > 0
        ? `downloading… ${rowPull.percent}%`
        : "downloading…"
      : !row.downloaded
      ? row.def.supportsVision
        ? "Enter — download (gguf + mmproj)"
        : "Enter — download"
      : row.mmprojStatus === "missing"
        ? "Enter — download mmproj"
        : !row.active
          ? "Enter — set active"
          : "Enter — already active";
    const fit = classifyRamFit(m, panel.totalRamGb);
    const vramFit = classifyVramFit(m, panel.gpuBudgetGb);
    return (
      <Box flexDirection="column">
        <Text bold color={theme.colors.accentSoft}>
          {m.name}
          {m.tag ? <Text color={theme.colors.accent}> [{m.tag}]</Text> : null}
        </Text>
        <Text color={theme.colors.muted}>{m.id}</Text>
        <Text>{m.description}</Text>
        <Text color={row.downloaded ? "green" : theme.colors.muted}>
          status: {row.downloaded ? "downloaded" : "not downloaded"}
          {row.active ? " · active" : ""}
        </Text>
        {row.def.supportsVision ? (
          <Text
            color={
              row.mmprojStatus === "downloaded"
                ? "green"
                : row.mmprojStatus === "missing"
                  ? "yellow"
                  : theme.colors.muted
            }
          >
            mmproj: {row.mmprojStatus}
          </Text>
        ) : null}
        <Text color={theme.colors.muted}>
          RAM {m.minRamGb}–{m.recommendedRamGb} GB · ctx {m.contextLabel} ·{" "}
          {m.sizeLabel}
        </Text>
        {fit && panel.totalRamGb !== null ? (
          <Text color={ramFitColor(fit)}>
            host RAM {panel.totalRamGb} GB — {ramFitLabel(fit, m)}
          </Text>
        ) : null}
        {vramFit === "insufficient" && panel.gpuBudgetGb !== null ? (
          <Text color={theme.colors.warnStrong}>
            Not enough VRAM — needs ~{estimateModelVramNeedGb(m).toFixed(1)} GB,
            GPU ~{panel.gpuBudgetGb.toFixed(1)} GB — may fail to load / crash
          </Text>
        ) : null}
        <Text color={theme.colors.muted}>
          {enterHint} · Esc back
        </Text>
      </Box>
    );
  }
  // `maxRows` is the TOTAL budget for the tab content. Split it between
  // the (possibly open) modals, the status footer, and the windowed
  // list. Ink garbles a frame taller than the terminal instead of
  // clipping it, so the footer collapses when the window is short.
  const useFullFooter = maxRows >= FULL_FOOTER_ROWS + FULL_FOOTER_MIN_LIST;
  const footerRows = useFullFooter ? FULL_FOOTER_ROWS : COMPACT_FOOTER_ROWS;
  const modalRows =
    (panel.embeddingOnboardingPrompt ? 6 : 0) +
    (panel.removeConfirmId ? 5 : 0) +
    (panel.embeddingRemoveConfirmId ? 5 : 0);
  const listBudget = Math.max(3, maxRows - footerRows - modalRows);
  return (
    <Box flexDirection="column">
      {panel.embeddingOnboardingPrompt ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={theme.colors.accent}
          paddingX={1}
          marginBottom={1}
        >
          <Text bold color={theme.colors.accentSoft}>
            ✦ Download embedding model for hybrid recall?
          </Text>
          <Text>
            {panel.embeddingOnboardingPrompt.name}{" "}
            <Text color={theme.colors.muted}>
              ({panel.embeddingOnboardingPrompt.sizeLabel})
            </Text>
          </Text>
          <Text color={theme.colors.muted}>
            Improves memory recall by blending BM25 with vector search.
            Runs as a paired daemon alongside chat — starts and stops
            together. Can be configured later from this panel.
          </Text>
          <Text>
            <Text bold color="green">
              (y)
            </Text>{" "}
            download + enable ·{" "}
            <Text bold>(n)</Text>/Esc skip for now
          </Text>
        </Box>
      ) : null}
      {panel.removeConfirmId ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="red"
          paddingX={1}
          marginBottom={1}
        >
          <Text bold color="red">
            ⚠ Delete model: {panel.removeConfirmId}
          </Text>
          <Text color={theme.colors.muted}>
            Removes the GGUF{" "}
            {panel.rows.find((r) => r.id === panel.removeConfirmId)?.def
              .supportsVision
              ? "(and mmproj) "
              : ""}
            from disk. If the daemon is serving this model it will be
            stopped first.
          </Text>
          <Text>
            <Text bold color="red">
              (y)
            </Text>{" "}
            confirm ·{" "}
            <Text bold>(n)</Text>/Esc cancel
          </Text>
        </Box>
      ) : null}
      {panel.embeddingRemoveConfirmId ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="red"
          paddingX={1}
          marginBottom={1}
        >
          <Text bold color="red">
            ⚠ Delete embedding model: {panel.embeddingRemoveConfirmId}
          </Text>
          <Text color={theme.colors.muted}>
            Removes the embedding GGUF from disk. If the embedding daemon
            is serving this model it will be stopped first; chat stays
            up.
          </Text>
          <Text>
            <Text bold color="red">
              (y)
            </Text>{" "}
            confirm ·{" "}
            <Text bold>(n)</Text>/Esc cancel
          </Text>
        </Box>
      ) : null}
      {renderModelLists(panel, listBudget)}
      {useFullFooter ? (
        <Box marginTop={1} flexDirection="column">
          <DownloadBanners panel={panel} />
          {panel.errorLine ? (
            <Text color="red">{panel.errorLine}</Text>
          ) : null}
          <Text color={theme.colors.muted}>
            mode: {panel.configMode}
            {panel.totalRamGb !== null ? ` · host RAM ${panel.totalRamGb} GB` : ""}
            {panel.lastRefreshedAt
              ? ` · refreshed ${new Date(panel.lastRefreshedAt).toLocaleTimeString()}`
              : ""}
          </Text>
          {renderDaemonLine(panel)}
          {renderEmbeddingDaemonLine(panel.embeddingDaemon)}
          {panel.daemonError ? (
            <Text color="red">daemon: {panel.daemonError}</Text>
          ) : null}
          {panel.dataDir ? (
            <Text color={theme.colors.muted}>
              data dir: {panel.dataDir} · backend{" "}
              {panel.backend.currentTag ?? "—"}
              {panel.backend.updateAvailable === true ? " (update available)" : ""}
              {panel.backend.autoUpdate ? "" : " · auto-update off"}
            </Text>
          ) : null}
          <Text color={theme.colors.muted}>
            j/k move · Enter pull/activate (embedding: *row + Enter starts server) · g gguf · i info · d remove · s chat+embedding · E embeddings on/off · G gpu · U auto-update · B · r · L
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          <DownloadBanners panel={panel} />
          {panel.errorLine ? (
            <Text color="red">{panel.errorLine}</Text>
          ) : null}
          {renderDaemonLine(panel)}
          <Text color={theme.colors.muted}>
            j/k · Enter · d remove · s start · r
          </Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * Choose between the full two-section view and a cursor-windowed
 * combined view. When the chat + embedding lists overflow the available
 * height, Ink would otherwise render a frame taller than the terminal
 * and overlap earlier lines; the windowed view keeps the selected row
 * visible and surfaces hidden counts while preserving the section
 * headers inline.
 */
function renderModelLists(
  panel: LocalModelsPanelState,
  maxRows: number,
): ReactElement {
  const total = panel.rows.length + panel.embeddingRows.length;
  // The full two-section view also emits two headers plus a margin
  // between the sections, so the fit check counts that overhead — not
  // just the row total — to avoid overflowing the budget by a few lines.
  const fullViewHeight = total + 3;
  if (fullViewHeight > maxRows) {
    return <WindowedModelRows panel={panel} maxRows={maxRows} />;
  }
  return (
    <>
      <Box flexDirection="column">
        <Text bold color={theme.colors.accentSoft}>
          Chat models ({panel.rows.length})
        </Text>
        {renderChatRows(panel)}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text bold color={theme.colors.accentSoft}>
          Embedding models ({panel.embeddingRows.length})
          <Text color={theme.colors.muted}> · paired with chat daemon</Text>
        </Text>
        {renderEmbeddingRows(panel)}
      </Box>
    </>
  );
}

function WindowedModelRows({
  panel,
  maxRows,
}: {
  panel: LocalModelsPanelState;
  maxRows: number;
}): ReactElement {
  const embOffset = panel.rows.length;
  const total = panel.rows.length + panel.embeddingRows.length;
  // Two section headers (Chat / Embedding) plus the ↑/↓ markers consume
  // lines; the data slice gets the remainder. Both headers are ALWAYS
  // rendered so the operator never loses the catalog structure on a
  // small window.
  const dataBudget = Math.max(1, maxRows - 2 - 2);
  const win = computeRowWindow(total, panel.cursor, dataBudget);
  const windowEnd = win.start + win.count;
  const chatVisible = panel.rows
    .map((row, i) => ({ row, i }))
    .filter(({ i }) => i >= win.start && i < windowEnd);
  const embeddingVisible = panel.embeddingRows
    .map((row, i) => ({ row, absIndex: embOffset + i, i }))
    .filter(({ absIndex }) => absIndex >= win.start && absIndex < windowEnd);
  return (
    <Box flexDirection="column">
      {win.hiddenBefore > 0 ? (
        <Text color={theme.colors.muted}>↑ {win.hiddenBefore} above</Text>
      ) : null}
      <Box flexDirection="column">
        <Text bold color={theme.colors.accentSoft}>
          Chat models ({panel.rows.length})
        </Text>
        {chatVisible.map(({ row, i }) => renderChatRow(panel, row, i))}
      </Box>
      <Box flexDirection="column">
        <Text bold color={theme.colors.accentSoft}>
          Embedding models ({panel.embeddingRows.length})
          <Text color={theme.colors.muted}> · paired with chat daemon</Text>
        </Text>
        {embeddingVisible.map(({ row, i }) => renderEmbeddingRow(panel, row, i))}
      </Box>
      {win.hiddenAfter > 0 ? (
        <Text color={theme.colors.muted}>↓ {win.hiddenAfter} below</Text>
      ) : null}
    </Box>
  );
}

function renderChatRows(panel: LocalModelsPanelState): ReactElement {
  if (panel.rows.length === 0) {
    return (
      <Text color={theme.colors.muted}>(no chat models in catalog)</Text>
    );
  }
  return (
    <Box flexDirection="column">
      {panel.rows.map((r, i) => renderChatRow(panel, r, i))}
    </Box>
  );
}

/** Single chat-model row. `index` is the row's position in `panel.rows`. */
function renderChatRow(
  panel: LocalModelsPanelState,
  r: LocalModelRow,
  index: number,
): ReactElement {
  const downloading =
    panel.pull !== null &&
    panel.pull.modelId !== "_backend" &&
    panel.pull.modelId === r.id;
  const mini = downloading ? renderProgressBar(panel.pull!.percent, 8) : "";
  const fit = classifyRamFit(r.def, panel.totalRamGb);
  const vramFit = classifyVramFit(r.def, panel.gpuBudgetGb);
  // A row that does not fit in RAM or VRAM is greyed out — but it
  // stays selectable and downloadable; the badge is informational.
  const insufficient = fit === "insufficient" || vramFit === "insufficient";
  // Cursor is a combined index across chat+embedding rows;
  // chat occupies [0..rows.length-1].
  const isCursor = index === panel.cursor;
  const rowColor = downloading
    ? "yellow"
    : isCursor
      ? theme.colors.accentSoft
      : insufficient
        ? theme.colors.muted
        : undefined;
  // `flexWrap="nowrap"` (the Box default) clips the row at the terminal
  // edge instead of spilling its trailing fragments onto a second
  // physical line, which Ink then overlaps with the next row — the
  // garble seen on a narrow window. The height-budget math elsewhere in
  // this panel assumes one row is one line, so a wrapped row also
  // desyncs the windowed slice. Keeping the fragments separate preserves
  // their individual colors; the badges that fall off the edge are
  // informational and reappear once the window is widened.
  return (
    <MouseListRow
      key={r.id}
      selected={isCursor}
      onSelect={(mouse) =>
        mouse.dispatch({ type: "local_models_cursor_set", row: index })
      }
      onActivate={pressEnter(handleLocalModelsTabKey)}
    >
    <Box flexDirection="row">
      <Text
        color={rowColor}
        bold={isCursor || downloading}
        dimColor={insufficient && !isCursor}
        wrap="truncate-end"
      >
        {isCursor ? "> " : "  "}
        {r.active ? "* " : ""}
        {r.id} {r.def.sizeLabel}
      </Text>
      <Text color={r.downloaded ? "green" : theme.colors.muted} wrap="truncate-end">
        {" "}
        [{renderRowAvailability(r)}]
      </Text>
      {r.def.tag ? (
        <Text color={theme.colors.accent} wrap="truncate-end"> [{r.def.tag}]</Text>
      ) : null}
      {fit ? (
        <Text color={ramFitColor(fit)} wrap="truncate-end">
          {" "}
          {fit === "ok" ? "✓ RAM" : fit === "tight" ? "△ RAM" : "✗ RAM"}
        </Text>
      ) : null}
      {vramFit === "insufficient" ? (
        <Text color={theme.colors.warnStrong} wrap="truncate-end"> Not enough VRAM</Text>
      ) : null}
      {downloading ? (
        <Text color="yellow" wrap="truncate-end">
          {" "}
          [{mini}] {panel.pull!.percent}%
        </Text>
      ) : null}
    </Box>
    </MouseListRow>
  );
}

/**
 * Memory-v2 phase 1B. One row per `EmbeddingModelRow`. Mirrors the
 * chat rows but skips RAM-fit and mmproj — embedding models are tiny
 * and text-only, so the noise is unwarranted.
 */
function renderEmbeddingRows(panel: LocalModelsPanelState): ReactElement {
  if (panel.embeddingRows.length === 0) {
    return (
      <Text color={theme.colors.muted}>
        (no embedding models in catalog)
      </Text>
    );
  }
  return (
    <Box flexDirection="column">
      {panel.embeddingRows.map((r, i) => renderEmbeddingRow(panel, r, i))}
    </Box>
  );
}

/**
 * Single embedding-model row. `index` is the row's position in
 * `panel.embeddingRows`; the combined cursor places embedding rows at
 * `[panel.rows.length .. panel.rows.length + emb.length - 1]`.
 */
function renderEmbeddingRow(
  panel: LocalModelsPanelState,
  r: EmbeddingModelRow,
  index: number,
): ReactElement {
  const embOffset = panel.rows.length;
  const downloading =
    panel.embeddingPull !== null && panel.embeddingPull.modelId === r.id;
  const mini = downloading
    ? renderProgressBar(panel.embeddingPull!.percent, 8)
    : "";
  const isCursor = embOffset + index === panel.cursor;
  const rowColor = downloading
    ? "yellow"
    : isCursor
      ? theme.colors.accentSoft
      : undefined;
  // See renderChatRow: nowrap + per-fragment truncate-end so a narrow
  // window clips the row instead of wrapping and overlapping the next.
  return (
    <MouseListRow
      key={r.id}
      selected={isCursor}
      onSelect={(mouse) =>
        mouse.dispatch({
          type: "local_models_cursor_set",
          row: embOffset + index,
        })
      }
      onActivate={pressEnter(handleLocalModelsTabKey)}
    >
    <Box flexDirection="row">
      <Text color={rowColor} bold={isCursor || downloading} wrap="truncate-end">
        {isCursor ? "> " : "  "}
        {r.active ? "* " : ""}
        {r.id} {r.def.sizeLabel}
      </Text>
      <Text color={r.downloaded ? "green" : theme.colors.muted} wrap="truncate-end">
        {" "}
        [{r.downloaded ? "gguf" : "remote"}]
      </Text>
      <Text color={theme.colors.muted} wrap="truncate-end">
        {" "}
        dim {r.def.dim}
      </Text>
      {downloading ? (
        <Text color="yellow" wrap="truncate-end">
          {" "}
          [{mini}] {panel.embeddingPull!.percent}%
        </Text>
      ) : null}
    </Box>
    </MouseListRow>
  );
}


