/**
 * Privacy Shield (ATO-1082) as the Privacy tab sees it. The switch and
 * the counter belong to the agent (`runtime.privacyShield`, ATO-1081):
 * this file only reads them. An agent build without it reports
 * `supported: false` and the tab says so instead of drawing a toggle
 * that does nothing. Same shape as `offline-mode.ts`.
 */

export interface PrivacyShieldControl {
  isEnabled(): boolean;
  setEnabled(enabled: boolean): Promise<void>;
  stats(sessionId?: string): { masked: number; sessions: number; session?: { masked: number } };
}

export interface ShieldPanelState {
  supported: boolean;
  enabled: boolean;
  /** Distinct values masked in this agent process; null when unreadable. */
  masked: number | null;
  /** The same for the active chat, when the tab knows which one it is. */
  sessionMasked: number | null;
}

export function createInitialShieldPanelState(): ShieldPanelState {
  return { supported: false, enabled: false, masked: null, sessionMasked: null };
}

/** `runtime.privacyShield`, or `null` when this build has none or it is malformed. */
export function readPrivacyShieldControl(runtime: unknown): PrivacyShieldControl | null {
  if (!runtime || typeof runtime !== "object") return null;
  const control = (runtime as { privacyShield?: unknown }).privacyShield;
  if (!control || typeof control !== "object") return null;
  const c = control as Partial<Record<keyof PrivacyShieldControl, unknown>>;
  if (
    typeof c.isEnabled !== "function" ||
    typeof c.setEnabled !== "function" ||
    typeof c.stats !== "function"
  ) {
    return null;
  }
  return control as PrivacyShieldControl;
}

function count(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
}

/** Snapshot the control into the panel slice. Never throws. */
export function snapshotPrivacyShield(
  control: PrivacyShieldControl | null,
  sessionId?: string,
): ShieldPanelState {
  if (!control) return createInitialShieldPanelState();
  let enabled = false;
  let masked: number | null = null;
  let sessionMasked: number | null = null;
  try {
    enabled = control.isEnabled() === true;
  } catch {
    enabled = false;
  }
  try {
    const stats = control.stats(sessionId);
    masked = count(stats?.masked);
    sessionMasked = sessionId ? count(stats?.session?.masked) : null;
  } catch {
    masked = null;
  }
  return { supported: true, enabled, masked, sessionMasked };
}

const values = (n: number): string => `${n} ${n === 1 ? "value" : "values"}`;

/**
 * "masked 3 values in this chat · 7 since the agent started". Built only
 * from the agent's counter; `null` when it could not be read.
 */
export function shieldCounterLine(shield: ShieldPanelState): string | null {
  if (shield.masked === null) return null;
  if (shield.sessionMasked === null) return `masked ${values(shield.masked)} since the agent started`;
  return `masked ${values(shield.sessionMasked)} in this chat · ${shield.masked} since the agent started`;
}
