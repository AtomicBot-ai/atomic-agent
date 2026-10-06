import { ConfigValidationError } from "./config-validation-error.js";
import { parseBool, parseNonNegativeInt, parseNonEmptyString } from "./config-primitives.js";
import { parseSessionRailConfig, type SessionRailConfig } from "./session-rail-config.js";

/**
 * Local end-of-turn pings, written to the terminal itself (config v71).
 *
 * Deliberately not part of `notifications`, which routes a message off
 * the machine — to Telegram, Discord or e-mail — and needs a channel
 * configured before it can say anything. This one has no channel and no
 * setup: it writes `OSC 9` plus a `BEL` to the session's own terminal,
 * which is exactly as far as it should carry.
 */
export interface TuiNotifyConfig {
  /** Off means the terminal is never written to out of band. */
  enabled: boolean;
  /**
   * How long a turn must have run before its *successful* ending is
   * worth a ping. A failure always pings regardless: it is the ending
   * that needs a person, and it can happen in two seconds.
   *
   * The floor exists because a bell on every turn is a bell an operator
   * learns to ignore, which costs the failures too.
   */
  minDurationMs: number;
}

/**
 * What Enter does in the TUI while a turn is already running.
 *
 * `steer` folds the message into the turn in flight (it reaches the
 * model at the next step boundary); `queue` parks it and runs it as its
 * own turn once the current one closes. Default is `steer` — an
 * operator who types *while* the agent is working is usually reacting
 * to what they see it doing.
 */
export type WhileBusySubmitMode = "steer" | "queue";

/**
 * First-run flow state (config v43, extended in v44). Five nullable
 * ISO-8601 timestamps, not booleans: knowing *when* a run was completed
 * or skipped is what lets a later release decide whether an install
 * predates a flow it would like to show again, and it costs the same
 * byte budget.
 *
 * - `introSeenAt` — the splash was dismissed at least once.
 * - `completedAt` — a backend was configured and the flow handed over to
 *   the agent. Set for the "custom endpoint" branch too.
 * - `skippedAt` — the operator escaped out. The flow does not reopen by
 *   itself afterwards; before v43 nothing was written here, which is why
 *   an escaped setup used to reappear on every single launch.
 * - `proposedSecondBackendAt` — the "you have one, want the other too?"
 *   screen was already offered, so it is never offered twice.
 * - `localSetupSeenAt` — the local model list was reached, whether or
 *   not a model came out of it. Recorded rather than derived because
 *   backing out of that list leaves no trace anywhere else, and it
 *   survives a launch: an interrupted first run is exactly the case
 *   where an operator would otherwise be shown it twice.
 */



export interface OnboardingState {
  completedAt: string | null;
  introSeenAt: string | null;
  skippedAt: string | null;
  proposedSecondBackendAt: string | null;
  localSetupSeenAt: string | null;
  importOfferedAt: string | null;
}

export interface TuiConfig {
  theme: string;
  whileBusySubmit: WhileBusySubmitMode;
  mouse: boolean;
  onboarding: OnboardingState;
  sessionRail: SessionRailConfig;
  notify: TuiNotifyConfig;
}

export function createTuiDefaults(): TuiConfig {
  return {
    theme: "auto",
    whileBusySubmit: "steer",
    mouse: true,
    notify: { enabled: true, minDurationMs: 30_000 },
    sessionRail: { order: [], pinned: [] },
    onboarding: {
      completedAt: null,
      importOfferedAt: null,
      introSeenAt: null,
      localSetupSeenAt: null,
      proposedSecondBackendAt: null,
      skippedAt: null,
    },
  };
}

/**
 * Parse `tui.whileBusySubmit` (added in config v38). Older config files predate the key and
 * are transparently upgraded to the `steer` default by the `??` at the
 * call site, so there is no migration step.
 */
export function parseWhileBusySubmit(
  raw: unknown,
  field: string,
): WhileBusySubmitMode {
  if (raw === "steer" || raw === "queue") return raw;
  throw new ConfigValidationError(
    field,
    `expected "steer" or "queue", got ${JSON.stringify(raw)}`,
  );
}

/**
 * An ISO-8601 instant or `null`. Validated through `Date.parse` rather
 * than a regex so a hand-edited file with a plausible-but-unparseable
 * stamp is rejected at load instead of producing an `Invalid Date`
 * somewhere far away.
 */
export function parseTimestampOrNull(
  raw: unknown,
  field: string,
): string | null {
  if (raw === undefined || raw === null) return null;
  const s = parseNonEmptyString(raw, field);
  if (Number.isNaN(Date.parse(s))) {
    throw new ConfigValidationError(
      field,
      `expected an ISO-8601 timestamp, got ${JSON.stringify(s)}`,
    );
  }
  return s;
}

/**
 * Parse `tui.theme`. Accepts the literal `"auto"` or any non-empty,
 * trimmed string (a theme name). The set of valid theme names lives in
 * the TUI layer (`isThemeName`); the config layer stays decoupled and
 * only enforces the string shape — an unknown name falls back to the
 * autodetect path at startup, never crashes. Anything non-string throws.
 */
export function parseThemeName(raw: unknown, field: string): string {
  if (typeof raw !== "string") {
    throw new ConfigValidationError(
      field,
      `expected a string, got ${JSON.stringify(raw)}`,
    );
  }
  const trimmed = raw.trim();
  return trimmed.length === 0 ? "auto" : trimmed;
}

/**
 * Parse `tui.onboarding`. Absent, `null`, or an empty object all mean a
 * fresh install, so every field falls back to `null` rather than
 * throwing — an older config file must never fail to load because it
 * predates the block.
 */
export function parseOnboardingStateWithDefaults(
  raw: unknown,
  readDefaults: () => OnboardingState,
): OnboardingState {
  const defaults = readDefaults();
  if (raw === undefined || raw === null) return { ...defaults };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(
      "tui.onboarding",
      `expected object, got ${JSON.stringify(raw)}`,
    );
  }
  const obj = raw as Record<string, unknown>;
  return {
    completedAt: parseTimestampOrNull(
      obj.completedAt,
      "tui.onboarding.completedAt",
    ),
    introSeenAt: parseTimestampOrNull(
      obj.introSeenAt,
      "tui.onboarding.introSeenAt",
    ),
    skippedAt: parseTimestampOrNull(obj.skippedAt, "tui.onboarding.skippedAt"),
    proposedSecondBackendAt: parseTimestampOrNull(
      obj.proposedSecondBackendAt,
      "tui.onboarding.proposedSecondBackendAt",
    ),
    localSetupSeenAt: parseTimestampOrNull(
      obj.localSetupSeenAt,
      "tui.onboarding.localSetupSeenAt",
    ),
    importOfferedAt: parseTimestampOrNull(
      obj.importOfferedAt,
      "tui.onboarding.importOfferedAt",
    ),
  };
}

/**
 * `tui.notify`, defaulted whole. Absent is the overwhelmingly common
 * case — every config written before v71 — so it is not an error, and a
 * present block still has each field checked rather than trusted.
 */
export function parseTuiNotifyWithDefaults(
  raw: unknown,
  readDefaults: () => TuiNotifyConfig,
): TuiNotifyConfig {
  const d = readDefaults();
  if (raw === undefined || raw === null) return { ...d };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigValidationError(
      "tui.notify",
      "expected an object with `enabled` and `minDurationMs`",
    );
  }
  const block = raw as Partial<TuiNotifyConfig>;
  return {
    enabled: parseBool(block.enabled ?? d.enabled, "tui.notify.enabled"),
    minDurationMs: parseNonNegativeInt(
      block.minDurationMs ?? d.minDurationMs,
      "tui.notify.minDurationMs",
    ),
  };
}

export function parseTuiConfig(
  tui: Record<string, unknown>,
  readDefaults: () => TuiConfig,
): TuiConfig {
  return {
    theme: parseThemeName(
      tui.theme ?? readDefaults().theme,
      "tui.theme",
    ),
    whileBusySubmit: parseWhileBusySubmit(
      tui.whileBusySubmit ?? readDefaults().whileBusySubmit,
      "tui.whileBusySubmit",
    ),
    mouse: parseBool(
      tui.mouse ?? readDefaults().mouse,
      "tui.mouse",
    ),
    onboarding: parseOnboardingStateWithDefaults(
      tui.onboarding,
      () => readDefaults().onboarding,
    ),
    sessionRail: parseSessionRailConfig(tui.sessionRail),
    notify: parseTuiNotifyWithDefaults(
      tui.notify,
      () => readDefaults().notify,
    ),
  };
}
