import type { RunModeName } from "../../config/llm-run-mode-config.js";
import { RUN_MODE_LABELS } from "./run-mode-nav.js";
import type { RunModePanelState } from "./run-mode-panel-state.js";

/**
 * Label for one pill in the Run-mode strip. Fusion carries its dial so
 * the split is visible without opening anything, and an unavailable
 * mode is annotated rather than hidden — a mode you cannot reach should
 * say why, not silently disappear.
 */
export function runModePillLabel(
  mode: RunModeName,
  panel: RunModePanelState,
): string {
  const base = RUN_MODE_LABELS[mode];
  if (mode === "fusion") {
    if (panel.cloudProviderMissing) return `${base} (no cloud provider)`;
    return panel.effective === "fusion"
      ? `${base} ${panel.cloudShare}%`
      : base;
  }
  if (mode === "cloud" && panel.cloudProviderMissing) {
    return `${base} (no cloud provider)`;
  }
  return base;
}

/** Model pair shown in the prompt meta row. */
export function runModeModelSummary(panel: RunModePanelState): string | null {
  if (panel.effective === "fusion") {
    if (!panel.cloudLabel || !panel.localLabel) return null;
    return `${panel.cloudLabel} ⇄ ${panel.localLabel}`;
  }
  return panel.effective === "cloud" ? panel.cloudLabel : panel.localLabel;
}

/** Dial rendered as a fixed-width bar so the row never reflows. */
export function formatCloudShareBar(cloudShare: number, width = 20): string {
  const filled = Math.round((cloudShare / 100) * width);
  return `${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}`;
}

/** How the dial reads in prose: what goes where. */
export function describeCloudShare(cloudShare: number): string {
  if (cloudShare <= 0) return "everything local";
  if (cloudShare >= 100) return "everything cloud";
  return `cloud handles steps scoring ≥ ${100 - cloudShare}`;
}
