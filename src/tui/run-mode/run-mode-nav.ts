import type { RunModeName } from "../../config/llm-run-mode-config.js";

/**
 * Run modes in display + cycle order.
 *
 * Deliberately NOT folded into `TuiTab` / `cycleSubTab`: a run mode is
 * not a view, and forcing it into the tab union would drag in
 * `getCurrentSection`, `tab_changed`, `NAV_SLOT_ORDER` and the persisted
 * `initialLayout` contract for something none of them describe.
 */
export const RUN_MODES: readonly RunModeName[] = ["local", "cloud", "fusion"];

export const RUN_MODE_LABELS: Record<RunModeName, string> = {
  local: "Local",
  cloud: "Cloud",
  fusion: "Fusion",
};

/** Step through the modes, wrapping in both directions. */
export function cycleRunMode(
  current: RunModeName,
  direction: 1 | -1,
): RunModeName {
  const idx = RUN_MODES.indexOf(current);
  const safe = idx === -1 ? 0 : idx;
  const next = (safe + direction + RUN_MODES.length) % RUN_MODES.length;
  return RUN_MODES[next] ?? RUN_MODES[0]!;
}

/** Smallest dial step, used by ←/→ in the picker. */
export const CLOUD_SHARE_STEP = 5;
/** Coarse dial step, used by shift+←/→. */
export const CLOUD_SHARE_COARSE_STEP = 25;

/** Clamp + quantise a dial value into the inclusive 0-100 range. */
export function clampCloudShare(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}
