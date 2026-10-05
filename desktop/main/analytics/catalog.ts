/**
 * The ONE allowlist of every analytics event the desktop shell may send,
 * with its allowed properties and, for enum properties, the allowed values
 * (the lists themselves live in catalog-values.ts).
 *
 * Documented in desktop/ANALYTICS.md. Owner says who fires it: `main` (this
 * process) or `ui` (the renderer, through `window.atomic.track`). The
 * renderer may only send `ui` events; main may send either.
 *
 * Runtime-owned events: most (`app_installed`, `message_sent`,
 * `first_message_sent`, …) the bundled agent fires itself and are not
 * listed. Two are, because the agent does not fire them under `atag serve`
 * (the desktop drives setup through config writes, not the TUI wizard), so
 * the shell sends them in the runtime's own schema: `model_configured`
 * (`provider` as the agent spells it — `llama.cpp` for the managed local
 * backend — and `kind`) and `analytics_disabled`.
 *
 * Anything not listed here is dropped by validate.ts — an unknown event, an
 * unknown property, a value of the wrong shape. Privacy rests on this file:
 * a property is only ever an enum from a fixed list, a count, a duration, a
 * boolean, or a known id.
 */

import { curatedMetaIds } from "../model-catalog.js";
import {
  APPROVAL_CATEGORIES, cleanAppVersion, cleanLocale, cleanQuant, CODING_MODES, CONFIGURED_PROVIDERS, DAEMON_EFFECTS,
  DOWNLOAD_FAIL_REASONS, DOWNLOAD_TRIGGERS, ERROR_CATEGORIES, FIT, GONE_REASONS, IMPORT_PARTS, IMPORT_SOURCES,
  NODE_SIGNALS, ONBOARDING_STEPS, PROVIDER_PRESETS, RAM_BUCKETS, RUN_MODES, SETTINGS_PANES, SLASH_COMMANDS,
  SWITCH_REFUSALS, uiActionOk, UI_VIA,
} from "./catalog-values.js";

export * from "./catalog-values.js";

export type PropSpec =
  | { kind: "enum"; values: readonly string[]; fallback?: string; nullable?: boolean }
  | { kind: "int"; min?: number; max?: number; nullable?: boolean }
  | { kind: "num"; min?: number; max?: number; decimals?: number; nullable?: boolean }
  | { kind: "bool" }
  /**
   * A short identifier-shaped string (≤64 chars, `^[a-zA-Z0-9_.:-]*$`).
   * `clean` may normalise it or refuse it (undefined); `fallback` replaces a
   * refused or non-string value.
   */
  | { kind: "str"; nullable?: boolean; clean?: (s: string) => string | undefined; fallback?: string }
  /** Built-in tool names; any MCP tool collapses to `mcp`. */
  | { kind: "tools" }
  | { kind: "boolMap"; keys: readonly string[] }
  | { kind: "intMap"; keys: readonly string[] };

export interface EventSpec {
  owner: "main" | "ui";
  props: Record<string, PropSpec>;
}

const en = (values: readonly string[], opts: { fallback?: string; nullable?: boolean } = {}): PropSpec => ({
  kind: "enum",
  values,
  ...opts,
});
const int = (opts: { min?: number; max?: number; nullable?: boolean } = {}): PropSpec => ({ kind: "int", min: 0, ...opts });
const num = (opts: { decimals?: number; nullable?: boolean } = {}): PropSpec => ({ kind: "num", min: 0, ...opts });
const bool: PropSpec = { kind: "bool" };
const ms = int();
/** An app version string (`0.6.7`); anything else is dropped. */
const appVersion: PropSpec = { kind: "str", clean: cleanAppVersion };

/** Curated catalogue ids, plus the two stand-ins for anything user-added. */
const modelIds = (): readonly string[] => [...curatedMetaIds(), "custom", "hf_custom"];

const downloadProps: Record<string, PropSpec> = {
  model_id: en(modelIds(), { fallback: "hf_custom" }),
  source: en(["curated", "hf"]),
  size_gb: num({ decimals: 1, nullable: true }),
  quant: { kind: "str", clean: cleanQuant, fallback: "unknown" },
  has_projector: bool,
  fit: en(FIT, { nullable: true }),
  trigger: en(DOWNLOAD_TRIGGERS),
};

export const EVENTS: Record<string, EventSpec> = {
  /* ---- lifecycle and health ---- */
  app_opened: { owner: "main", props: { launch_kind: en(["cold", "reopen"]), fresh_state: bool, prev_session_crashed: bool } },
  app_ready: { owner: "main", props: { ms_to_window: int({ nullable: true }), ms_to_agent: int({ nullable: true }), backend_up_at_launch: bool } },
  agent_start_failed: {
    owner: "main",
    props: {
      reason: en(["missing_binary", "exited", "health_timeout", "other"]),
      exit_code: int({ min: -2147483648, nullable: true }),
      signal: en(NODE_SIGNALS, { nullable: true }),
      ms,
    },
  },
  agent_restarted: { owner: "main", props: { trigger: en(["manual", "switch", "other"]) } },
  window_crashed: {
    owner: "main",
    props: {
      kind: en(["gone", "unresponsive"]),
      reason: en(GONE_REASONS, { nullable: true }),
      exit_code: int({ min: -2147483648, nullable: true }),
    },
  },
  app_closed: { owner: "main", props: { session_minutes: num({ decimals: 1 }), turns_in_session: int() } },
  debug_report_saved: { owner: "main", props: { kind: en(["dump", "report"]) } },
  analytics_disabled: { owner: "main", props: { via: en(["settings", "slash", "config"]), days_since_install: int() } },

  /* ---- onboarding and setup ---- */
  onboarding_step: {
    owner: "ui",
    props: {
      step: en(ONBOARDING_STEPS),
      prev_step: en(ONBOARDING_STEPS, { nullable: true }),
      ms_on_prev_step: int({ nullable: true }),
      outcome: en(["local", "cloud", "custom", "skipped"]),
    },
  },
  onboarding_skipped: { owner: "ui", props: { at_step: en(ONBOARDING_STEPS) } },   // includes `other`
  model_picked: {
    owner: "ui",
    props: {
      model_id: en(modelIds(), { fallback: "custom" }),
      size_gb: num({ decimals: 1, nullable: true }),
      fit: en(FIT, { nullable: true }),
      host_ram_gb: en(RAM_BUCKETS, { nullable: true }),
    },
  },
  provider_setup_started: { owner: "ui", props: { provider_preset: en(PROVIDER_PRESETS, { fallback: "custom" }) } },
  provider_key_checked: {
    owner: "main",
    props: {
      provider_preset: en(PROVIDER_PRESETS, { fallback: "custom" }),
      result: en(["ok", "rejected", "unreachable", "payment_required"]),
      http_status: int({ min: 100, max: 599, nullable: true }),
    },
  },
  provider_setup_failed: {
    owner: "ui",
    props: { step: en(["onboarding", "settings"]), reason: en(["bad_url", "bad_key_chars", "save_failed", "catalog_empty", "other"]) },
  },
  custom_endpoint_tested: { owner: "ui", props: { kind: en(["chat", "embedding"]), reachable: bool } },
  model_configured: {
    owner: "main",
    props: { provider: en(CONFIGURED_PROVIDERS, { fallback: "custom" }), kind: en(["local", "cloud", "custom"]) },
  },

  /* ---- models, downloads, backend ---- */
  model_download_started: { owner: "main", props: downloadProps },
  model_download_finished: {
    owner: "main",
    props: {
      ...downloadProps,
      result: en(["ok", "failed", "cancelled"]),
      reason: en(DOWNLOAD_FAIL_REASONS, { nullable: true }),
      ms,
      avg_mbps: num({ decimals: 1, nullable: true }),
      percent_reached: int({ max: 100, nullable: true }),
    },
  },
  hf_lookup: {
    owner: "main",
    props: {
      result: en(["ok", "unreachable", "gated", "not_found", "no_gguf", "none_servable", "other"]),
      choices_count: int(),
    },
  },
  llama_runtime_updated: {
    owner: "main",
    props: { trigger: en(["setup", "settings"]), result: en(["ok", "up_to_date", "failed", "cancelled"]), ms },
  },
  local_backend_started: {
    owner: "main",
    props: { via: en(["launch", "swap"]), result: en(DAEMON_EFFECTS), model_id: en(modelIds(), { fallback: "hf_custom" }), ms: int({ nullable: true }) },
  },
  backend_switched: {
    owner: "main",
    props: {
      from: en(RUN_MODES, { nullable: true }),
      to: en(RUN_MODES, { nullable: true }),
      result: en(["ok", "refused", "failed", "timeout"]),
      refusal: en(SWITCH_REFUSALS, { nullable: true }),
      restart: bool,
      ms,
    },
  },
  fusion_configured: {
    owner: "main",
    props: {
      action: en(["enter", "swap_legs", "set_workers", "pick_worker_model"]),
      workers: int({ min: 1, max: 8, nullable: true }),
      degraded: bool,
    },
  },

  /* ---- chat turns and approvals ---- */
  chat_turn_ui: {
    owner: "main",
    props: {
      outcome: en(["completed", "failed", "cancelled"]),
      ms_to_first_token: int({ nullable: true }),
      ms_total: ms,
      queue_wait_ms: ms,
      steer_count: int(),
      approvals_asked: int(),
      tool_calls: int(),
      tools_used: { kind: "tools" },
      error_category: en(ERROR_CATEGORIES, { nullable: true }),
      coding_mode: en(CODING_MODES, { nullable: true }),
    },
  },
  message_action: {
    owner: "ui",
    props: { action: en(["copy", "resend", "retry", "continue", "steer", "unqueue", "stop", "copy_reply"]) },
  },
  approval_answered: {
    owner: "ui",
    props: {
      choice: en(["allow_once", "deny", "abort", "deny_with_text"]),
      category: en(APPROVAL_CATEGORIES),
      level: int({ max: 9, nullable: true }),
      input: en(["click", "key"]),
      ms_to_answer: int({ nullable: true }),
    },
  },
  /* ATO-203: a card that closed with no answer: its turn was stopped or ended
     (`stopped` / `expired`), a newer request for the same call replaced it
     (`replaced`), or the agent no longer held it when it was answered
     (`not_waiting`, the resolve route's 404). */
  approval_closed: {
    owner: "ui",
    props: {
      how: en(["stopped", "expired", "replaced", "not_waiting"]),
      category: en(APPROVAL_CATEGORIES),
      level: int({ max: 9, nullable: true }),
      ms_open: int({ nullable: true }),
    },
  },
  coding_mode_changed: {
    owner: "ui",
    props: {
      from: en(CODING_MODES, { nullable: true }),
      to: en(CODING_MODES),
      via: en(["menu", "plan_bar", "shortcut", "palette", "other"]),
    },
  },
  plan_handoff: { owner: "ui", props: { choice: en(["auto", "bypass", "dismiss"]) } },

  /* ---- navigation and features ---- */
  /* `prefix`, `prefix:tail` or `runmode:workers:N` — the renderer keeps only enum tails; uiActionOk refuses anything id-like. */
  ui_action: {
    owner: "ui",
    props: { action: { kind: "str", clean: (a: string) => (uiActionOk(a) ? a : undefined) }, via: en(UI_VIA) },
  },
  slash_command_used: { owner: "ui", props: { command: en(SLASH_COMMANDS, { fallback: "unknown" }) } },
  settings_pane_viewed: { owner: "ui", props: { pane: en(SETTINGS_PANES), ms_on_pane: int({ nullable: true }) } },
  session_action: {
    owner: "ui",
    props: { action: en(["new", "switch", "open", "pin", "unpin", "mark_unread", "delete", "load_more", "clear"]) },
  },
  voice_used: {
    owner: "main",
    props: {
      action: en(["start", "stop", "cancel"]),
      result: en(["ok", "error"]),
      duration_s: num({ decimals: 1, nullable: true }),
      locale: { kind: "str", nullable: true, clean: cleanLocale },
      error: en(["spawn", "too_long", "other"], { nullable: true }),
    },
  },
  voice_setup: {
    owner: "main",
    props: {
      result: en(["ok", "install_failed", "unavailable"]),
      reason: en(["voice-not-macos", "voice-os-too-old", "voice-helper-missing", "voice-helper-failed"], { nullable: true }),
    },
  },
  task_created: { owner: "main", props: { kind: en(["cron", "interval", "at"]) } },
  task_action: { owner: "main", props: { action: en(["run", "cancel"]) } },
  skill_installed: { owner: "main", props: { result: en(["ok", "blocked", "error"]), risk_acknowledged: bool } },
  skill_action: { owner: "main", props: { action: en(["enable", "disable", "remove"]) } },
  mcp_server_added: { owner: "ui", props: { result: en(["ok", "error"]) } },
  mcp_server_action: { owner: "ui", props: { action: en(["toggle", "restart", "remove"]) } },
  telegram_setup: {
    owner: "main",
    props: {
      step: en(["enable", "token_saved", "token_cleared", "owner_cleared"]),
      result: en(["ok", "error"]),
    },
  },
  import_run: {
    owner: "main",
    props: {
      source: en(IMPORT_SOURCES),
      parts: { kind: "boolMap", keys: IMPORT_PARTS },
      result: en(["ok", "partial", "error"]),
      counts: { kind: "intMap", keys: IMPORT_PARTS },
    },
  },
  workspace_chosen: { owner: "main", props: {} },

  /* ---- app updates (ATO-229, main/updater.ts) ---- */
  update_available: { owner: "main", props: { version: appVersion, trigger: en(["auto", "manual"]) } },
  update_accepted: { owner: "main", props: { version: appVersion } },
  update_dismissed: { owner: "main", props: { version: appVersion, via: en(["not_now", "cancel", "later"]) } },
  update_skipped: { owner: "main", props: { version: appVersion } },
  /* Sent on the first start of the new version, from what the old one wrote before it quit to install. */
  update_installed: { owner: "main", props: { version: appVersion, from_version: appVersion } },
};
