/**
 * Offline mode (ATO-1087) as the Privacy tab sees it. The switch itself and
 * the outbound counter belong to the agent's network kill switch (ATO-1084):
 * this file only reads them. Nothing here pretends: an agent build without
 * the switch reports `null`, and the tab says the mode is not available
 * instead of drawing a toggle that does nothing.
 *
 * Expected on the runtime object (added by ATO-1084):
 *
 *   runtime.offlineMode = {
 *     isEnabled(): boolean;
 *     setEnabled(enabled: boolean): Promise<void>; // persists + applies live
 *     egress(): OfflineEgressSnapshot;
 *   }
 */

/** Traffic to anything but this computer, as the agent counted it. */
export interface OfflineEgressSnapshot {
  /** Bytes written to non-loopback hosts. */
  bytesOut: number;
  /** Requests to non-loopback hosts that were let through. */
  requestsOut: number;
  /** Attempts the kill switch refused. */
  requestsBlocked: number;
  /** ISO time the counters start from (reset when offline mode turns on). */
  since: string;
}

export interface OfflineModeControl {
  isEnabled(): boolean;
  setEnabled(enabled: boolean): Promise<void>;
  egress(): OfflineEgressSnapshot;
}

/** Panel slice: what the agent reported the last time the tab refreshed. */
export interface OfflinePanelState {
  /** False when the running agent has no kill switch. */
  supported: boolean;
  enabled: boolean;
  /** Null until the agent has given a well-formed counter. */
  egress: OfflineEgressSnapshot | null;
}

export function createInitialOfflinePanelState(): OfflinePanelState {
  return { supported: false, enabled: false, egress: null };
}

/**
 * The runtime's offline-mode control, or `null` when this agent build has
 * none (or it is not shaped as expected). Structural on purpose: the TUI
 * must keep working against a runtime that predates the kill switch.
 */
export function readOfflineModeControl(
  runtime: unknown,
): OfflineModeControl | null {
  if (!runtime || typeof runtime !== "object") return null;
  const control = (runtime as { offlineMode?: unknown }).offlineMode;
  if (!control || typeof control !== "object") return null;
  const c = control as Partial<Record<keyof OfflineModeControl, unknown>>;
  if (
    typeof c.isEnabled !== "function" ||
    typeof c.setEnabled !== "function" ||
    typeof c.egress !== "function"
  ) {
    return null;
  }
  return control as OfflineModeControl;
}

function count(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0
    ? Math.floor(v)
    : null;
}

/** A counter the agent reported, or `null` when any field is missing/bad. */
export function normalizeEgress(raw: unknown): OfflineEgressSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const bytesOut = count(r.bytesOut);
  const requestsOut = count(r.requestsOut);
  const requestsBlocked = count(r.requestsBlocked);
  const since = typeof r.since === "string" ? r.since : null;
  if (
    bytesOut === null ||
    requestsOut === null ||
    requestsBlocked === null ||
    since === null ||
    !Number.isFinite(Date.parse(since))
  ) {
    return null;
  }
  return { bytesOut, requestsOut, requestsBlocked, since };
}

/** Snapshot the control into the panel slice. Never throws. */
export function snapshotOfflineMode(
  control: OfflineModeControl | null,
): OfflinePanelState {
  if (!control) return createInitialOfflinePanelState();
  let enabled = false;
  let egress: OfflineEgressSnapshot | null = null;
  try {
    enabled = control.isEnabled() === true;
  } catch {
    enabled = false;
  }
  try {
    egress = normalizeEgress(control.egress());
  } catch {
    egress = null;
  }
  return { supported: true, enabled, egress };
}

/** "0 bytes", "1 byte", "512 bytes", "1.5 KB", "12 MB". */
export function formatEgressBytes(n: number): string {
  if (n === 1) return "1 byte";
  if (n < 1024) return `${n} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const shown = v < 10 ? v.toFixed(1).replace(/\.0$/, "") : String(Math.round(v));
  return `${shown} ${units[i]}`;
}

function clock(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * The counter line, built only from what the agent reported:
 * "0 bytes sent out since 14:05 · 3 requests blocked". `null` when there
 * is no counter to show (the tab then says it could not read one).
 */
export function offlineEgressLine(
  egress: OfflineEgressSnapshot | null,
): string | null {
  if (!egress) return null;
  let line = `${formatEgressBytes(egress.bytesOut)} sent out since ${clock(egress.since)}`;
  if (egress.requestsBlocked > 0) {
    line += ` · ${egress.requestsBlocked} ${egress.requestsBlocked === 1 ? "request" : "requests"} blocked`;
  }
  return line;
}
