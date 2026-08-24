import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { theme } from "../theme/theme.js";
import type { TuiState } from "../tui-state.js";
import {
  selectLlmActiveRouteSummary,
  selectLlmPanelRows,
} from "../llm-panel/llm-panel-selectors.js";
import type { LocalModelsPanelState } from "../local-models/local-models-panel-state.js";
import { LLM_PANEL_MODES, type LlmPanelMode } from "../llm-panel/llm-panel-state.js";
import { isLocalModelsHfOpen } from "../local-models/local-models-hf-keys.js";
import { LlmModeRows } from "./llm-mode-rows.js";
import { LocalModelsHuggingFaceBranch } from "./local-models-hf-branch.js";
import { hasLlmModal, LlmPanelModals } from "./llm-panel-modals.js";
import { renderProgressBar } from "./render-progress-bar.js";

/**
 * Rows consumed by the full fixed chrome: RouteCard (~7) + ModeHeader (3)
 * + StatusLines (2) + footer (2). Used to decide whether the full header
 * fits; below the threshold we collapse to a 1-line route summary so the
 * list (and its section headers) still fit without overflowing the
 * terminal — Ink garbles, it does not clip, when content is too tall.
 */
const FULL_HEADER_ROWS = 13;
/** Rows consumed by the collapsed header: route (1) + status (1) + footer (1). */
const COMPACT_HEADER_ROWS = 3;
/**
 * Minimum list rows required before we keep the full header. The windowed
 * list always renders both section headers plus a hidden-count marker, so
 * it needs a few rows of room — committing to the verbose RouteCard with
 * less than this would push the section headers off the budget (Ink then
 * garbles the frame). Below the threshold we collapse to `CompactHeader`.
 */
const FULL_HEADER_MIN_LIST = 3;

export function LlmPanel({
  state,
  maxRows = 12,
}: {
  state: TuiState;
  maxRows?: number;
}): ReactElement {
  const rows = selectLlmPanelRows(state);
  const summary = selectLlmActiveRouteSummary(state);
  const starting =
    state.llmPanel.mode === "local" && isDaemonStarting(state.localModelsPanel);
  // `maxRows` is the TOTAL budget for the tab content. Split it between
  // the fixed header and the (windowed) list, collapsing the verbose
  // RouteCard when the terminal is too short to afford it.
  const useFull = maxRows >= FULL_HEADER_ROWS + FULL_HEADER_MIN_LIST;
  const headerRows = useFull ? FULL_HEADER_ROWS : COMPACT_HEADER_ROWS;
  const listBudget = Math.max(1, maxRows - headerRows);
  // A modal takes the whole budget and the panel behind it is not drawn.
  // The two used to be stacked, which spent the budget twice over: Ink 7
  // does not clip an over-tall frame, it paints later lines over earlier
  // ones, so the add-provider list arrived on screen with most of its
  // rows overwritten by the panel underneath (reports #1 and #2). The
  // panel is unreachable while a modal is open anyway —
  // `handleLlmModalKey` claims every key — so nothing is lost by hiding
  // it, and the modal finally gets a height it can size itself against.
  if (hasLlmModal(state)) {
    return (
      <Box flexDirection="column" width="100%">
        <LlmPanelModals state={state} maxRows={maxRows} />
      </Box>
    );
  }
  // "Add a model from Hugging Face" takes the whole pane, for the same
  // reason the modals above do: it owns every key while it is open, so
  // drawing the model list behind it would be a list nothing can reach.
  if (isLocalModelsHfOpen(state)) {
    return (
      <Box flexDirection="column" width="100%">
        <LocalModelsHuggingFaceBranch panel={state.localModelsPanel} />
      </Box>
    );
  }
  return (
    <Box flexDirection="column" width="100%">
      {/* The starting banner and active-download banners are important
          feedback — keep them visible regardless of the compact/full
          header decision. */}
      {starting ? <StartingBanner /> : null}
      {state.llmPanel.mode === "local" ? (
        <DownloadBanners panel={state.localModelsPanel} />
      ) : null}
      {useFull ? (
        <>
          <RouteCard state={state} summary={summary} />
          <ModeHeader mode={state.llmPanel.mode} />
          <StatusLines state={state} />
        </>
      ) : (
        <CompactHeader state={state} summary={summary} />
      )}
      <Box flexDirection="column">
        <LlmModeRows rows={rows} state={state} maxRows={listBudget} />
      </Box>
      <Box marginTop={useFull ? 1 : 0} flexDirection="column">
        <Text color={theme.colors.muted}>{footerHint(state.llmPanel.mode, useFull)}</Text>
      </Box>
    </Box>
  );
}

/**
 * One-line route + status header used when the terminal is too short to
 * fit the full RouteCard without garbling the frame.
 */
function CompactHeader({
  state,
  summary,
}: {
  state: TuiState;
  summary: ReturnType<typeof selectLlmActiveRouteSummary>;
}): ReactElement {
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold color={theme.colors.accentSoft}>
          {summary.providerLabel}
        </Text>
        {summary.textModel ? (
          <Text color={theme.colors.muted}> / {summary.textModel}</Text>
        ) : null}
        <Text color={theme.colors.muted}> · {state.llmPanel.mode}</Text>
      </Text>
      <StatusLines state={state} compact />
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

const MODE_LABELS: Record<LlmPanelMode, string> = {
  local: "Local",
  cloud: "Cloud",
  external: "External llama.cpp",
  fallback: "Fallback",
};

/** Footer key hint, pane-specific for Fallback (its edit keys differ). */
function footerHint(mode: LlmPanelMode, useFull: boolean): string {
  if (mode === "fallback") {
    return useFull
      ? "j/k move · < > reorder · a add link · d remove · l toggle local · ←/→ switch pane · r refresh"
      : "j/k · < > reorder · a add · d remove · l local · ←/→ pane";
  }
  if (mode === "local") {
    return useFull
      ? "j/k move · Enter selected action · a add from hugging face · ←/→ switch Local/Cloud/External/Fallback · s start/stop · r refresh"
      : "j/k · Enter · a add · ←/→ mode · r";
  }
  return useFull
    ? "j/k move · Enter selected action · ←/→ switch Local/Cloud/External/Fallback · f filter · n add provider · c configure · r refresh"
    : "j/k · Enter · ←/→ mode · f filter · r";
}

function ModeHeader({ mode }: { mode: LlmPanelMode }): ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        Mode:{" "}
        {LLM_PANEL_MODES.map((candidate, index) => (
          <Text key={candidate}>
            {index > 0 ? <Text color={theme.colors.muted}> | </Text> : null}
            <Text
              bold
              color={
                candidate === mode ? theme.colors.accentSoft : theme.colors.muted
              }
            >
              {MODE_LABELS[candidate]}
            </Text>
          </Text>
        ))}
      </Text>
      <Text color={theme.colors.muted}>Press ←/→ to switch mode</Text>
    </Box>
  );
}

function StatusLines({
  state,
  compact = false,
}: {
  state: TuiState;
  compact?: boolean;
}): ReactElement | null {
  const lines: string[] = [];
  if (state.llmPanel.mode === "local") {
    // Only surface "loading" on the very first catalog fetch (no snapshot
    // yet). Background/active-cadence refreshes toggle `loading` true→false
    // constantly; gating on `lastRefreshedAt === null` stops the status line
    // from flickering between "loading" and "ready" after a download.
    if (
      state.localModelsPanel.loading &&
      state.localModelsPanel.lastRefreshedAt === null
    ) {
      lines.push("local catalog: loading");
    }
    if (state.localModelsPanel.errorLine) {
      lines.push(`local catalog: ${state.localModelsPanel.errorLine}`);
    }
    if (state.localModelsPanel.daemonError) {
      lines.push(`local daemon: ${state.localModelsPanel.daemonError}`);
    }
  } else if (state.llmPanel.mode === "external") {
    // The External pane's status messages (probe verdicts from the URL
    // save) describe an external llama.cpp, so the "cloud providers:"
    // prefix would mislabel exactly the line the operator must act on.
    // Only external-sourced lines render here: a cloud catalog refresh
    // reporting on this pane, unprefixed, read as a verdict on the URL.
    if (
      state.providersPanel.statusLine &&
      state.providersPanel.statusLineSource === "external"
    ) {
      lines.push(state.providersPanel.statusLine);
    }
  } else {
    if (state.providersPanel.busy) lines.push("cloud providers: updating");
    if (
      state.providersPanel.statusLine &&
      state.providersPanel.statusLineSource === "cloud"
    ) {
      lines.push(`cloud providers: ${state.providersPanel.statusLine}`);
    }
  }
  return (
    <Box flexDirection="column" marginBottom={compact ? 0 : 1}>
      <Text color={theme.colors.muted}>{lines[0] ?? "status: ready"}</Text>
    </Box>
  );
}

/**
 * True for the window between "model downloaded" and "llama-server is
 * answering /health": the orchestrator stamps `daemonPhase = "starting"`
 * before the blocking start, then the process comes up with
 * `daemon.loading` set while it loads the weights into memory. During
 * this window the panel inputs are paused, so we surface a big banner.
 */
function isDaemonStarting(panel: LocalModelsPanelState): boolean {
  if (panel.daemonPhase === "starting") return true;
  return panel.daemon.running && panel.daemon.loading;
}

function StartingBanner(): ReactElement {
  return (
    <Box
      flexDirection="column"
      marginBottom={1}
      borderStyle="round"
      borderColor={theme.colors.success}
      paddingX={1}
    >
      <Text bold color={theme.colors.success}>
        ⟳ Model is starting — please stand by
      </Text>
      <Text color={theme.colors.muted}>
        Loading the model into llama-server. Inputs are paused until it is ready.
      </Text>
    </Box>
  );
}

function DownloadBanners({
  panel,
}: {
  panel: LocalModelsPanelState;
}): ReactElement | null {
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
  const width = 36;
  const bar = renderProgressBar(pull.percent, width);
  const xfer = formatDownloadBytes(pull.transferredBytes);
  const totalPart =
    pull.totalBytes > 0 ? ` / ${formatDownloadBytes(pull.totalBytes)}` : "";
  const target =
    pull.modelId === "_backend" ? "target: backend zip" : `model: ${pull.modelId}`;
  return (
    <Box flexDirection="column">
      <Text bold color={theme.colors.accentSoft}>
        downloading — {pull.label}
      </Text>
      <Text color={theme.colors.muted}>{target}</Text>
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

function formatDownloadBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
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

