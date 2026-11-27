/**
 * Names, addresses and organisations in Privacy Shield (ATO-2527), as
 * the Privacy tab sees them. The switch and the model choice belong to
 * the agent (`runtime.privacyShield.localNames`); this file only reads
 * them and words the hint. An agent without the switch gives `null` and
 * the tab draws no row for it.
 */

export type NamesState = "off" | "ready" | "no-local-model" | "provider-not-shielded";

export interface NamesPanelState {
  enabled: boolean;
  state: NamesState;
  /** "qwen3-4b (lmstudio)", or `null` when no model on this computer is set up. */
  model: string | null;
}

/** The part of the agent's control this file reads. */
export interface PrivacyNamesControl {
  status(): { enabled: boolean; state: string; model: { provider: string; model: string | null } | null };
  setEnabled(enabled: boolean): Promise<void>;
}

/** `control.localNames`, or `null` when the agent has none or it is malformed. */
export function readPrivacyNamesControl(control: unknown): PrivacyNamesControl | null {
  if (!control || typeof control !== "object") return null;
  const names = (control as { localNames?: unknown }).localNames;
  if (!names || typeof names !== "object") return null;
  const n = names as Partial<Record<keyof PrivacyNamesControl, unknown>>;
  if (typeof n.status !== "function" || typeof n.setEnabled !== "function") return null;
  return names as PrivacyNamesControl;
}

const STATES: ReadonlySet<string> = new Set(["off", "ready", "no-local-model", "provider-not-shielded"]);

/** Snapshot the names switch. Never throws; an unreadable status gives `null`. */
export function snapshotPrivacyNames(control: PrivacyNamesControl | null): NamesPanelState | null {
  if (!control) return null;
  try {
    const status = control.status();
    if (!status || typeof status.enabled !== "boolean" || !STATES.has(status.state)) return null;
    const m = status.model;
    const model = m && typeof m.provider === "string" ? (m.model ? `${m.model} (${m.provider})` : m.provider) : null;
    return { enabled: status.enabled, state: status.state as NamesState, model };
  } catch {
    return null;
  }
}

const REGEX_ONLY = "only emails, phone numbers, cards and keys are hidden";

/**
 * The line under the names switch: which model reads the text, and what
 * happens without one. `shieldOn` is the main Privacy Shield switch.
 */
export function namesHintLine(names: NamesPanelState, shieldOn: boolean): string {
  if (names.state === "provider-not-shielded") {
    return "The current chat model (a ChatGPT sign-in or a Claude Code or Codex CLI) is not covered by Privacy Shield, so nothing is hidden from it.";
  }
  if (names.state === "ready" && names.model) {
    const lead = shieldOn ? "" : "Works when Privacy Shield is on. ";
    return `${lead}Read by ${names.model} on this computer before a cloud request. If that model is not running, ${REGEX_ONLY}.`;
  }
  if (names.state === "no-local-model") {
    return `Needs a model on this computer (the built-in local model, or LM Studio or Ollama on localhost). None is set up, so ${REGEX_ONLY}.`;
  }
  if (names.model) {
    return `Off. When on, ${names.model} on this computer finds them; the text is never sent anywhere else for this.`;
  }
  return "Off. Needs a model on this computer (the built-in local model, or LM Studio or Ollama on localhost).";
}
