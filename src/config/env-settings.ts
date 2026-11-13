import { ENV_DEFAULTS } from "./config-schema.js";

/**
 * The one table of settings that come from environment variables (ATO-41).
 *
 * Most settings live in `<stateDir>/config.json` (see
 * `settings-reference.ts`). The variables below are read by `loadConfig`
 * (and the analytics kill switch) from the process environment or from
 * `<stateDir>/.env`. Two kinds:
 *
 *   - `overrides` set: the variable wins over that config.json key when
 *     both are set (an operator override; the start-up log names the
 *     source for the local-model pair).
 *   - `overrides` null: env-only. There is no config.json key; this table
 *     is the only place they are listed for users.
 *
 * Defaults are taken from `ENV_DEFAULTS` wherever one exists, so this
 * table cannot quote a stale number. `env-settings.test.ts` scans `src/`
 * and fails when an `ATOMIC_AGENT_*` name is read that is neither here
 * nor in `INTERNAL_ENV_NAMES`, so a new variable cannot stay undocumented.
 */
export interface EnvSetting {
  /** Variable name, e.g. `ATOMIC_AGENT_STATE_DIR`. */
  readonly name: string;
  /** The config.json key this variable wins over, or null when env-only. */
  readonly overrides: string | null;
  /** Value used when the variable is unset; null when there is none. */
  readonly default: string | number | boolean | null;
  /** One-sentence description for people. */
  readonly description: string;
}

const env = (
  name: string,
  defaultValue: EnvSetting["default"],
  description: string,
  overrides: string | null = null,
): EnvSetting => ({ name, overrides, default: defaultValue, description });

export const ENV_SETTINGS: readonly EnvSetting[] = [
  // Where everything lives.
  env("ATOMIC_AGENT_STATE_DIR", ENV_DEFAULTS.STATE_DIR, "State directory: config.json, .env, sessions, memory, models and traces. Shared by the terminal agent and the desktop app."),
  env("ATOMIC_AGENT_GRAMMARS_DIR", null, "Folder with the tool-call grammars. Unset: the copy shipped next to the binary."),

  // Env variables that win over a config.json key.
  env("ATOMIC_AGENT_LLAMA_MAX_TOKENS", null, "Cap on tokens one local-model reply may produce, 64 to 131072. Wins over the config value when set.", "localModels.completionMaxTokens"),
  env("ATOMIC_AGENT_LLAMA_REQUEST_TIMEOUT_MS", null, "Budget of one local-model request (the idle gap for a stream), in ms. Wins over the config value when set.", "localModels.requestTimeoutMs"),
  env("ATOMIC_AGENT_SKILLS_CATALOG_BUDGET", null, "Token budget of the skills list in the prompt, 1 to 100000. Wins over the config value when set.", "skills.catalogTokenBudget"),
  env("ATOMIC_AGENT_BROWSER_CDP_URL", null, "Attach the browser tools to an already running Chrome at this DevTools URL. Wins over the config value when set.", "browser.cdpUrl"),

  // Local model connection.
  env("ATOMIC_AGENT_LLAMA_API_KEY", null, "API key sent to the local model server. Unset: the managed server's own key, or none."),
  env("ATOMIC_AGENT_LLAMA_HEALTH_TIMEOUT_MS", ENV_DEFAULTS.HEALTH_TIMEOUT_MS, "Timeout of one health check of the local model server, in ms."),
  env("ATOMIC_AGENT_LLAMA_FIRST_TOKEN_TIMEOUT_MS", ENV_DEFAULTS.FIRST_TOKEN_TIMEOUT_MS, "How long a local stream may wait for its first token, in ms."),
  env("ATOMIC_AGENT_LLAMA_STREAM_TOTAL_TIMEOUT_MS", ENV_DEFAULTS.STREAM_TOTAL_TIMEOUT_MS, "Backstop on one whole streaming reply from a local model, in ms."),
  env("ATOMIC_AGENT_LLAMA_HEALTH_RETRIES", ENV_DEFAULTS.HEALTH_RETRIES, "Health-check attempts before the local model server counts as down."),
  env("ATOMIC_AGENT_LLAMA_HEALTH_BACKOFF_MS", ENV_DEFAULTS.HEALTH_BACKOFF_MS, "Pause between health-check attempts, in ms."),
  env("ATOMIC_AGENT_LLAMA_COMPLETION_RETRIES", ENV_DEFAULTS.COMPLETION_RETRIES, "Retries of a failed local completion request."),
  env("ATOMIC_AGENT_LLAMA_COMPLETION_RETRY_BACKOFF_MS", ENV_DEFAULTS.COMPLETION_RETRY_BACKOFF_MS, "Pause between local completion retries, in ms."),
  env("ATOMIC_AGENT_LLAMA_DEFAULT_SLOT", ENV_DEFAULTS.DEFAULT_SLOT_ID, "llama.cpp slot id used for the chat."),

  // Agent loop.
  env("ATOMIC_AGENT_STABLE_PREFIX_SALT", ENV_DEFAULTS.STABLE_PREFIX_SALT, "Salt of the prompt-prefix hash. Changing it invalidates cached prompt prefixes."),
  env("ATOMIC_AGENT_LOADED_TOOLS_CAP", ENV_DEFAULTS.LOADED_TOOLS_CAP, "How many rarely used tool schemas a session keeps loaded, 1 to 64."),
  env("ATOMIC_AGENT_LOADED_TOOLS_MAX_TOKENS", ENV_DEFAULTS.LOADED_TOOLS_MAX_TOKENS, "Token cap of the loaded-tools prompt section, 0 to 8000."),
  env("ATOMIC_AGENT_AUTO_EXPAND_RARE_ON_ERROR", ENV_DEFAULTS.AUTO_EXPAND_RARE_ON_ERROR, "Attach a rare tool's full schema after the tool fails."),
  env("ATOMIC_AGENT_MAX_PARALLEL_TOOL_CALLS", ENV_DEFAULTS.MAX_PARALLEL_TOOL_CALLS, "Soft cap on tool calls in one step, 1 to 16."),
  env("ATOMIC_AGENT_BATCH_TOOL_RESULT_CHAR_CAP", ENV_DEFAULTS.BATCH_TOOL_RESULT_CHAR_CAP, "Cap on the combined characters of all tool results in one step."),
  env("ATOMIC_AGENT_SHELL_TOOL_RESULT_CHAR_CAP", ENV_DEFAULTS.SHELL_TOOL_RESULT_CHAR_CAP, "Cap on the characters of one shell command result the model sees."),
  env("ATOMIC_AGENT_SHELL_TOOL_RESULT_TAIL_LINES", ENV_DEFAULTS.SHELL_TOOL_RESULT_TAIL_LINES, "How many last lines of a shell command result the model sees."),
  env("ATOMIC_AGENT_LOOP_WARNING_THRESHOLD", ENV_DEFAULTS.LOOP_WARNING_THRESHOLD, "Repeats of the same call before the model is told it is not making progress."),
  env("ATOMIC_AGENT_LOOP_CRITICAL_THRESHOLD", ENV_DEFAULTS.LOOP_CRITICAL_THRESHOLD, "Identical call-and-result streak that blocks the next identical call."),
  env("ATOMIC_AGENT_LOOP_BREAKER_VETO_STREAK", ENV_DEFAULTS.LOOP_BREAKER_VETO_STREAK, "Blocked calls in a row before the agent is made to reply instead."),
  env("ATOMIC_AGENT_LOOP_HISTORY_SIZE", ENV_DEFAULTS.LOOP_HISTORY_SIZE, "How many recent calls the loop detector remembers."),
  env("ATOMIC_AGENT_LOOP_WANDERING_THRESHOLD", ENV_DEFAULTS.LOOP_WANDERING_THRESHOLD, "Calls with varied arguments to one tool before the model is redirected."),
  env("ATOMIC_AGENT_LOOP_WANDERING_ESCALATION", ENV_DEFAULTS.LOOP_WANDERING_ESCALATION, "Calls with varied arguments to one tool before the agent is made to reply."),
  env("ATOMIC_AGENT_REPLY_POLISH", true, "Clean up the final reply before a chat surface shows it."),

  // Browser tools.
  env("ATOMIC_AGENT_BROWSER_ENABLED", ENV_DEFAULTS.BROWSER_ENABLED, "Register the browser tools."),
  env("ATOMIC_AGENT_BROWSER_CHANNEL", ENV_DEFAULTS.BROWSER_CHANNEL, "Browser to launch: chrome, msedge or chromium."),
  env("ATOMIC_AGENT_BROWSER_HEADLESS", ENV_DEFAULTS.BROWSER_HEADLESS, "Run the agent's browser without a window."),
  env("ATOMIC_AGENT_BROWSER_EXECUTABLE_PATH", null, "Path of the browser binary to launch instead of the channel's default."),
  env("ATOMIC_AGENT_BROWSER_NO_SANDBOX", ENV_DEFAULTS.BROWSER_NO_SANDBOX, "Launch the browser without its sandbox (some containers need this)."),
  env("ATOMIC_AGENT_BROWSER_LAUNCH_TIMEOUT_MS", ENV_DEFAULTS.BROWSER_LAUNCH_TIMEOUT_MS, "How long to wait for the browser to start, in ms."),

  // Background tasks.
  env("ATOMIC_AGENT_TASKS_ENABLED", ENV_DEFAULTS.TASKS_ENABLED, "Background task queue."),
  env("ATOMIC_AGENT_TASKS_MAX_ATTEMPTS", ENV_DEFAULTS.TASKS_MAX_ATTEMPTS, "Attempts before a failing task is marked failed."),
  env("ATOMIC_AGENT_TASKS_BACKOFF_INITIAL_MS", ENV_DEFAULTS.TASKS_BACKOFF_INITIAL_MS, "First retry delay of a failed task, in ms."),
  env("ATOMIC_AGENT_TASKS_BACKOFF_MAX_MS", ENV_DEFAULTS.TASKS_BACKOFF_MAX_MS, "Longest retry delay of a failed task, in ms."),
  env("ATOMIC_AGENT_TASKS_RUN_ON_CREATE", ENV_DEFAULTS.TASKS_RUN_ON_CREATE, "Start a task as soon as it is created."),
  env("ATOMIC_AGENT_TASKS_STALE_AFTER_MS", ENV_DEFAULTS.TASKS_STALE_AFTER_MS, "A running task with no progress for this long is put back in the queue, in ms."),
  env("ATOMIC_AGENT_TASKS_SCHEDULER_ENABLED", ENV_DEFAULTS.TASKS_SCHEDULER_ENABLED, "Scheduler that wakes up timed and repeating tasks."),
  env("ATOMIC_AGENT_TASKS_SCHEDULER_TICK_MS", ENV_DEFAULTS.TASKS_SCHEDULER_TICK_MS, "Scheduler polling interval, in ms."),
  env("ATOMIC_AGENT_TASKS_SCHEDULER_BATCH", ENV_DEFAULTS.TASKS_SCHEDULER_BATCH, "Most due tasks started per scheduler tick."),
  env("ATOMIC_AGENT_TASKS_AGENT_TOOLS_ENABLED", ENV_DEFAULTS.TASKS_AGENT_TOOLS_ENABLED, "Let the agent schedule, list and cancel tasks itself."),
  env("ATOMIC_AGENT_TASKS_MIN_INTERVAL_MS", ENV_DEFAULTS.TASKS_MIN_INTERVAL_MS, "Shortest allowed interval of a repeating task, in ms."),
  env("ATOMIC_AGENT_TASKS_REPORT_QUIET_HOURS", null, "Hold task reports in this local-time window and send one digest after it, e.g. 23:00-08:00."),
  env("ATOMIC_AGENT_STATUS_SNAPSHOT_EVERY_STEPS", ENV_DEFAULTS.STATUS_SNAPSHOT_EVERY_STEPS, "Post a status snapshot of a long run every this many steps; 0 turns it off."),
  env("ATOMIC_AGENT_STATUS_SNAPSHOT_EVERY_MS", ENV_DEFAULTS.STATUS_SNAPSHOT_EVERY_MS, "Post a status snapshot of a long run this often, in ms; 0 turns it off."),

  // Updates and analytics.
  env("ATOMIC_AGENT_UPDATE_CHECK_ON_STARTUP", ENV_DEFAULTS.UPDATE_CHECK_ON_STARTUP, "Check GitHub Releases for a newer version when the TUI starts."),
  env("ATOMIC_AGENT_REPO", ENV_DEFAULTS.UPDATE_REPO, "GitHub owner/repo used for update checks and self-update."),
  env("ATOMIC_AGENT_ANALYTICS", null, "Set to off to turn anonymous analytics and crash reports off for this process, whatever analytics.enabled says. Not saved."),
  env("DO_NOT_TRACK", null, "Set to 1 to turn analytics and crash reports off, the same as ATOMIC_AGENT_ANALYTICS=off."),
];

/**
 * `ATOMIC_AGENT_*` names the code reads that are not settings: values the
 * apps pass to each other, or names on a deny list. Kept so the coverage
 * test can tell "deliberately not a setting" from "forgot to document".
 */
export const INTERNAL_ENV_NAMES: ReadonlyMap<string, string> = new Map([
  ["ATOMIC_AGENT_API_KEY", "a secret name kept out of the shell tool's child environment"],
  ["ATOMIC_AGENT_OPENAI_API_KEY", "a secret name kept out of child process environments"],
  ["ATOMIC_AGENT_GIT_CREDENTIAL", "set only on the git child process to pass the GitHub token"],
  ["ATOMIC_AGENT_SURFACE", "set by the desktop app on the agent it starts"],
  ["ATOMIC_AGENT_DESKTOP_VERSION", "set by the desktop app on the agent it starts"],
  ["ATOMIC_AGENT_INSTALL_CHANNEL", "set by installers for analytics"],
  ["ATOMIC_AGENT_INSTALL_ID_FILE", "the shared analytics install id file, passed through by the desktop app"],
  ["ATOMIC_AGENT_TEAM", "marks team test runs in analytics"],
  ["ATOMIC_AGENT_SESSION_PARENT_PID", "set by the desktop app on every agent process it starts"],
  ["ATOMIC_AGENT_USER_PATH_B64", "used internally by the Windows uninstaller"],
]);

/** The env variable that wins over `configKey`, or null. */
export function envOverrideFor(configKey: string, table: readonly EnvSetting[] = ENV_SETTINGS): string | null {
  return table.find((setting) => setting.overrides === configKey)?.name ?? null;
}
