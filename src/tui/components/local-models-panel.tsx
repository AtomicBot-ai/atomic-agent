import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import {
  classifyRamFit,
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
}

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

function DownloadBanner({ panel }: { panel: LocalModelsPanelState }): ReactElement | null {
  const pull = panel.pull;
  if (!pull) return null;
  const w = 36;
  const bar = renderProgressBar(pull.percent, w);
  const total = pull.totalBytes > 0 ? pull.totalBytes : null;
  const xfer = formatDownloadBytes(pull.transferredBytes);
  const totalPart =
    total !== null ? ` / ${formatDownloadBytes(total)}` : "";
  const isModel = pull.modelId !== "_backend";
  const modelLine = isModel ? `model: ${pull.modelId}` : "target: backend zip";
  return (
    <Box flexDirection="column" marginBottom={1}>
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

export function LocalModelsPanel({ panel }: LocalModelsPanelProps): ReactElement {
  if (panel.mode === "backendUpdate") {
    return (
      <Box flexDirection="column">
        <Text color={theme.colors.muted}>backend update…</Text>
      </Box>
    );
  }
  if (panel.mode === "detail") {
    const row = panel.rows[panel.cursor];
    if (!row) return <Text color={theme.colors.muted}>(no row)</Text>;
    const m = row.def;
    const enterHint = !row.downloaded
      ? row.def.supportsVision
        ? "Enter — download (gguf + mmproj)"
        : "Enter — download"
      : row.mmprojStatus === "missing"
        ? "Enter — download mmproj"
        : !row.active
          ? "Enter — set active"
          : "Enter — already active";
    const fit = classifyRamFit(m, panel.totalRamGb);
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
        <Text color={theme.colors.muted}>
          {enterHint} · Esc back
        </Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Box flexDirection="column">
        {panel.rows.map((r, i) => {
          const downloading =
            panel.pull !== null &&
            panel.pull.modelId !== "_backend" &&
            panel.pull.modelId === r.id;
          const mini = downloading
            ? renderProgressBar(panel.pull!.percent, 8)
            : "";
          const fit = classifyRamFit(r.def, panel.totalRamGb);
          const rowColor = downloading
            ? "yellow"
            : i === panel.cursor
              ? theme.colors.accentSoft
              : fit === "insufficient"
                ? theme.colors.muted
                : undefined;
          return (
            <Box key={r.id} flexDirection="row" flexWrap="wrap">
              <Text
                color={rowColor}
                bold={i === panel.cursor || downloading}
                dimColor={fit === "insufficient" && i !== panel.cursor}
              >
                {r.active ? "* " : "  "}
                {r.id} {r.def.sizeLabel}
              </Text>
              <Text color={r.downloaded ? "green" : theme.colors.muted}>
                {" "}
                [{renderRowAvailability(r)}]
              </Text>
              {r.def.tag ? (
                <Text color={theme.colors.accent}> [{r.def.tag}]</Text>
              ) : null}
              {fit ? (
                <Text color={ramFitColor(fit)}>
                  {" "}
                  {fit === "ok" ? "✓ RAM" : fit === "tight" ? "△ RAM" : "✗ RAM"}
                </Text>
              ) : null}
              {downloading ? (
                <Text color="yellow">
                  {" "}
                  [{mini}] {panel.pull!.percent}%
                </Text>
              ) : null}
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <DownloadBanner panel={panel} />
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
        {panel.daemonError ? (
          <Text color="red">daemon: {panel.daemonError}</Text>
        ) : null}
        {panel.dataDir ? (
          <Text color={theme.colors.muted}>
            data dir: {panel.dataDir} · backend {panel.backend.currentTag ?? "—"}
            {panel.backend.updateAvailable === true ? " (update available)" : ""}
          </Text>
        ) : null}
        <Text color={theme.colors.muted}>
          j/k move · Enter download/activate (incl. mmproj) · g gguf only · s start/stop · i info · d remove · B backend · r refresh · L logs
        </Text>
      </Box>
    </Box>
  );
}
