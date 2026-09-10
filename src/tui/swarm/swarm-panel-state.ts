import type { ChannelStatus } from "../../runtime/channel-status.js";

/**
 * UI state for the "Swarm" tab: every bot this runtime runs — the two
 * primary channels (managed in Integrations) plus any extra units — with
 * add / edit / remove / pair / restart for the units.
 *
 * The orchestrator pushes rows in through `swarm_synced`; the reducer
 * only folds actions and never touches config, `.env` or the runtime.
 */

export type SwarmKind = "telegram" | "discord";

export interface SwarmRow {
  /** Unit id, or `primary:telegram` / `primary:discord`. */
  id: string;
  kind: SwarmKind;
  /** The two config-level channels. Read-only here; edited in Integrations. */
  primary: boolean;
  label: string;
  role: string;
  enabled: boolean;
  hasToken: boolean;
  ownerUserId: string | null;
  state: ChannelStatus["state"];
  lastError: string | null;
  botUsername: string | null;
  /** Telegram pairing window, when one is open. */
  pairing: { active: boolean; secondsLeft: number | null } | null;
}

export type SwarmPanelMode = "list" | "add" | "edit" | "remove";

/** Wizard steps for adding a bot, in order. */
export const SWARM_ADD_STEPS = [
  "kind",
  "label",
  "role",
  "token",
  "owner",
] as const;
export type SwarmAddStep = (typeof SWARM_ADD_STEPS)[number];

/** Editable unit fields, in the order the detail view lists them. */
export const SWARM_EDIT_FIELDS = ["label", "role", "owner", "token"] as const;
export type SwarmEditField = (typeof SWARM_EDIT_FIELDS)[number];

export interface SwarmAddForm {
  step: SwarmAddStep;
  kind: SwarmKind;
  label: string;
  role: string;
  /**
   * Held in plain text while typed — the operator has to see what they
   * paste — masked the moment it is saved, never logged.
   */
  token: string;
  owner: string;
}

export interface SwarmPanelState {
  mode: SwarmPanelMode;
  rows: readonly SwarmRow[];
  /** Index into `rows`. Clamped by the reducer, never out of range. */
  selected: number;
  form: SwarmAddForm;
  /** Detail view cursor. */
  editField: SwarmEditField;
  /** `null` = browsing fields; a string = typing a new value. */
  editBuffer: string | null;
  /** True while an add / save / remove is in flight. */
  busy: boolean;
  message: string | null;
  lastError: string | null;
}

export function createInitialSwarmAddForm(): SwarmAddForm {
  return {
    step: "kind",
    kind: "telegram",
    label: "",
    role: "",
    token: "",
    owner: "",
  };
}

export function createInitialSwarmPanelState(): SwarmPanelState {
  return {
    mode: "list",
    rows: [],
    selected: 0,
    form: createInitialSwarmAddForm(),
    editField: "label",
    editBuffer: null,
    busy: false,
    message: null,
    lastError: null,
  };
}

/** The row under the cursor, or `undefined` when the list is empty. */
export function selectedSwarmRow(state: SwarmPanelState): SwarmRow | undefined {
  return state.rows[state.selected];
}

/**
 * Bots that count as "alive" for the hatchery: switched on, holding a
 * token, and not reporting a failure. One critter each — a bot whose
 * row says `down` must not have a critter scurrying for it, or the
 * strip contradicts the list right above it.
 */
export function aliveSwarmCount(rows: readonly SwarmRow[]): number {
  return rows.filter((r) => r.enabled && r.hasToken && r.state !== "down")
    .length;
}

/** The text the wizard is currently editing. */
export function formStepValue(form: SwarmAddForm): string {
  switch (form.step) {
    case "label":
      return form.label;
    case "role":
      return form.role;
    case "token":
      return form.token;
    case "owner":
      return form.owner;
    default:
      return "";
  }
}
