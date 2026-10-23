/**
 * The fixed value lists the event catalogue (catalog.ts) is built from, and
 * the few shape rules for the properties that are strings rather than enums
 * (`ui_action.action`, `quant`, `locale`). See desktop/ANALYTICS.md.
 *
 * Pure: no Electron, no fs — the unit tests drive it straight.
 */

export const ONBOARDING_STEPS = [
  "intro", "choose", "local_pick", "local_hf_ref", "local_hf_pick", "local_download", "wait_or_jump",
  "cloud", "custom_chat_url", "custom_embedding_url", "propose_second", "import_pick", "import_preview",
  "import_done", "finished", "other",
] as const;

/** Provider preset ids (src/llm/provider/presets/provider-presets.ts + the built-in cloud kinds). */
export const PROVIDER_PRESETS = [
  "openrouter", "openai", "anthropic", "gemini", "groq", "aimlapi", "atomic-chat", "cerebras", "deepseek",
  "fireworks", "hyperbolic", "lmstudio", "mistral", "moonshot", "nous", "novita", "ollama", "ollama-cloud",
  "perplexity", "dashscope", "sambanova", "sarvam", "together", "xai", "local-llama", "custom",
] as const;
/** `model_configured.provider` as the agent runtime spells it: the managed local backend is `llama.cpp`. */
export const CONFIGURED_PROVIDERS = [...PROVIDER_PRESETS, "llama.cpp"] as const;

export const RUN_MODES = ["local", "cloud", "fusion"] as const;
/** The managed local engine (`localModels.managed.engine`): Atomic Chat Core is the default, llama.cpp the way back. */
export const LOCAL_ENGINES = ["atomic-core", "llama-server"] as const;
/** Why the local engine is not ready (main/engine-failure.ts EngineFailureStage). */
export const ENGINE_FAILURE_STAGES = ["download", "verify", "backend", "blocked", "start"] as const;
/** `engine_recovery_shown.via`: what put the recovery card up (main.ts noteEngine). */
export const ENGINE_RECOVERY_VIA = ["launch", "swap", "update", "start", "switch", "setup", "settings", "other"] as const;
/** `local_backend_supervised.kind`: what the engine watchdog did (main/daemon-supervisor.ts SupervisorNotice, without `clear`). */
export const SUPERVISOR_KINDS = ["restarting", "restarted", "restart_failed", "gave_up"] as const;
/** `local_backend_supervised.fault`: the server log's failure line as a code (classify.ts engineFault); the line itself is never sent. */
export const ENGINE_FAULTS = ["oom", "port_in_use", "load_failed", "missing_lib", "crash", "unknown"] as const;
export const CODING_MODES = ["default", "plan", "auto", "bypass", "other"] as const;
export const FIT = ["comfortable", "tight", "over"] as const;
/** `model_picked.host_ram_gb`: ≤12 → 8, ≤24 → 16, ≤48 → 32, else 64 (renderer/analytics.js ramBucket). */
export const RAM_BUCKETS = ["8", "16", "32", "64"] as const;
export const ERROR_CATEGORIES = ["transport", "grammar", "model", "tool", "cancelled"] as const;
export const NODE_SIGNALS = [
  "SIGTERM", "SIGKILL", "SIGINT", "SIGHUP", "SIGQUIT", "SIGABRT", "SIGSEGV", "SIGBUS", "SIGILL", "SIGFPE",
  "SIGPIPE", "SIGTRAP", "SIGSYS", "SIGUSR1", "SIGUSR2", "SIGBREAK",
] as const;
/** Electron's RenderProcessGoneDetails.reason / child-process-gone reason. */
export const GONE_REASONS = [
  "clean-exit", "abnormal-exit", "killed", "crashed", "oom", "launch-failed", "integrity-failure", "memory-eviction",
] as const;
/** The renderer's SLASH table (renderer.js). Anything else is `unknown`. */
export const SLASH_COMMANDS = [
  "dump", "report", "help", "tools", "theme", "onboarding", "setup", "clear", "abort", "quit", "debug", "chat",
  "runmode", "observe", "manage", "feed", "logs", "reasoning", "world", "expand", "collapse", "session",
  "sessions", "new", "skills", "skill", "memory", "llm", "mcp", "model", "tasks", "task", "telegram",
  "import", "privacy", "analytics", "compact", "unknown",
] as const;
/** The renderer's approval CATS ids. */
export const APPROVAL_CATEGORIES = [
  "fs_write_workspace", "fs_write_home", "fs_trash", "http", "shell", "script", "proc_kill", "publish",
  "git_remote", "fusion_fanout", "browser_nonweb", "trust_config", "email", "fs_read_outside", "paid_generation", "other",
] as const;
export const SETTINGS_PANES = [
  "general", "models", "mcp", "telegram", "composio", "memory", "tasks", "skills", "privacy", "import", "diagnostics",
] as const;
export const IMPORT_SOURCES = ["tui", "hermes", "openclaw", "claude-code", "codex", "pi", "other"] as const;
export const IMPORT_PARTS = ["providers", "keys", "skills", "sessions", "memory"] as const;
export const DAEMON_EFFECTS = [
  "started", "restarted", "start_failed", "stop_failed", "skipped", "superseded", "untouched", "stopped",
] as const;
export const SWITCH_REFUSALS = [
  "turn_running", "switch_running", "needs_provider", "needs_key", "key_invalid", "needs_model",
  "needs_chat_model", "needs_download", "no_provider", "other",
] as const;
export const DOWNLOAD_FAIL_REASONS = [
  "offline", "busy", "exited", "disk_full", "http_error", "no_progress", "other",
] as const;
export const DOWNLOAD_TRIGGERS = ["onboarding", "settings", "selector", "other"] as const;
export const UI_VIA = ["click", "menu", "shortcut", "palette", "slash", "other"] as const;

/* ---- string shapes ---- */

/** `prefix`, `prefix:tail` or `prefix:tail:tail`; segments may be camelCase (`sel:browseLocal`). */
export const UI_ACTION_RE = /^[a-zA-Z][a-zA-Z0-9_.-]*(:[a-zA-Z0-9_.-]+){0,2}$/;
const UUID_IN_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const HEX_RUN_RE = /[0-9a-f]{6,}/gi;
const DIGITS4_RE = /\d{4,}/;

/** A segment that could be someone's id: a UUID, a hex run with digits in it, 4+ digits, or a bare number. */
function idLike(seg: string, numericOk: boolean): boolean {
  if (UUID_IN_RE.test(seg) || DIGITS4_RE.test(seg)) return true;
  for (const run of seg.match(HEX_RUN_RE) ?? []) if (/\d/.test(run)) return true;
  return /^\d+$/.test(seg) && !numericOk;
}

/**
 * The renderer already keeps only allowlisted tails; this is main's second
 * look. The one number an action may carry is the Fusion worker count.
 */
export function uiActionOk(a: string): boolean {
  if (a.length > 64 || !UI_ACTION_RE.test(a)) return false;
  const workers = /^runmode:workers:[1-8]$/.test(a);
  return !a.split(":").some((seg, i) => idLike(seg, workers && i === 2));
}

/** GGUF quant tag, upper-cased (`Q4_K_M`, `IQ3_XXS`, `F16`, `BF16`, `MXFP4`), else `unknown`. */
export const QUANT_RE = /^(i?q\d[a-z0-9_]{0,10}|f16|f32|bf16|mxfp4|unknown)$/i;
export function cleanQuant(q: string): string {
  return QUANT_RE.test(q) ? (q.toLowerCase() === "unknown" ? "unknown" : q.toUpperCase()) : "unknown";
}

/** An app version (`0.6.7`, `1.0.0-beta.2`); anything else is dropped. ATO-229's update_* events. */
export const APP_VERSION_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}(-[0-9A-Za-z.-]{1,32})?$/;
export function cleanAppVersion(v: string): string | undefined {
  return APP_VERSION_RE.test(v) ? v : undefined;
}

/** A speech locale (`en`, `en-US`, `yue-HK`); anything else is dropped. */
export const LOCALE_RE = /^[a-z]{2,3}(-[A-Z]{2})?$/;
export function cleanLocale(l: string): string | undefined {
  return LOCALE_RE.test(l) ? l : undefined;
}

/**
 * `agent_restarted.trigger` (ATO-274). `manual` is the person's own restart
 * (Settings, the palette); finishing setup, a new workspace folder and a
 * data import restart the agent too and are told apart, so `manual` can be
 * read as "something felt stuck".
 */
export const RESTART_TRIGGERS = ["manual", "switch", "auto", "other", "setup_finished", "workspace_change", "import"] as const;
export type RestartTrigger = (typeof RESTART_TRIGGERS)[number];
/** The window's `agent:restart` says why only for setup; anything else it sends is a manual restart. */
export function restartTriggerFromWindow(reason: unknown): RestartTrigger {
  return reason === "setup_finished" ? "setup_finished" : "manual";
}
