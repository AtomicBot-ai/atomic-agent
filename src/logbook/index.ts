export {
  clampInterval,
  clampRetention,
  DEFAULT_INTERVAL_MINUTES,
  DEFAULT_LOGBOOK_SETTINGS,
  DEFAULT_RETENTION_DAYS,
  ensureLogbookDir,
  isStandupClock,
  LOGBOOK_DIR,
  logbookCapturing,
  logbookDir,
  MAX_INTERVAL_MINUTES,
  MAX_RETENTION_DAYS,
  MIN_INTERVAL_MINUTES,
  MIN_RETENTION_DAYS,
  parseLogbookSettings,
  readLogbookSettings,
  writeLogbookSettings,
} from "./logbook-settings.js";
export type { LogbookSettings } from "./logbook-settings.js";

export {
  appendLogbookEntry,
  clearLogbookDays,
  clearLogbookRange,
  dayKey,
  deleteLogbookEntries,
  dayKeyOffset,
  isDayKey,
  listLogbookDays,
  logbookToolOffered,
  minuteOfDay,
  pruneLogbook,
  readLogbookDay,
} from "./logbook-store.js";
export type { LogbookClearScope, LogbookEntry } from "./logbook-store.js";

export { parseLogbookStatus, readLogbookStatus, writeLogbookStatus } from "./logbook-status.js";
export type { LogbookOutcome, LogbookStatus } from "./logbook-status.js";

export {
  INDICATOR_TTL_MS,
  indicatorState,
  parseLogbookIndicator,
  readLogbookIndicator,
  writeLogbookIndicator,
} from "./logbook-indicator.js";
export type { IndicatorState, LogbookIndicator } from "./logbook-indicator.js";

export { logbookSkipReason } from "./logbook-skip.js";
export type { FrontApp } from "./logbook-skip.js";

export {
  entryRunsOnThisMachine,
  logbookNotesStayLocal,
  NO_LOCAL_VISION_REASON,
  pickLocalVisionProvider,
} from "./logbook-local-vision.js";
export type {
  LogbookNotesRouteArgs,
  LogbookVisionProvider,
  PickLocalVisionArgs,
  PickLocalVisionResult,
} from "./logbook-local-vision.js";

export {
  buildLogbookQuery,
  DAY_PARTS,
  DEFAULT_QUERY_LIMIT,
  describeWindow,
  formatLogbookEntries,
  MAX_QUERY_LIMIT,
  parseClock,
  parseDaySpec,
  selectLogbookEntries,
} from "./logbook-query.js";
export type { LogbookQuery } from "./logbook-query.js";

export { captureLogbookFrame, cleanObservation, IDLE_REASON, LOGBOOK_PROMPT, logbookCaptureOptions, titleOnlyText } from "./logbook-capture.js";
export type { LogbookCaptureDeps, LogbookCaptureOptions, LogbookCaptureOutcome } from "./logbook-capture.js";

export { createLogbookSidecar, INDICATOR_AWAY_REASON, INDICATOR_HIDDEN_REASON, PRUNE_EVERY_MS } from "./logbook-sidecar.js";
export type { LogbookSidecar, LogbookSidecarDeps } from "./logbook-sidecar.js";

export {
  logbookPlatformSupport,
  logbookState,
  readLogbookView,
  UNSUPPORTED_PLATFORM_REASON,
} from "./logbook-view.js";
export type { LogbookPlatformSupport, LogbookState, LogbookView } from "./logbook-view.js";

export {
  applyLogbookAction,
  DEFAULT_PAUSE_MINUTES,
  MAX_PAUSE_MINUTES,
  parseLogbookAction,
} from "./logbook-actions.js";
export type { LogbookAction, LogbookActionResult } from "./logbook-actions.js";

export {
  applyLogbookPreferences,
  hasPreferences,
  parseLogbookPreferences,
  PREFERENCE_KEYS,
} from "./logbook-preferences.js";
export type { LogbookPreferences, ParsedPreferences } from "./logbook-preferences.js";

export {
  LOGBOOK_STANDUP_FILE,
  readStandupState,
  reconcileStandup,
  STANDUP_CHECK_EVERY_MS,
  standupCron,
  wantedStandup,
  writeStandupState,
} from "./logbook-standup.js";
export type { StandupState, StandupTasks } from "./logbook-standup.js";

export { probeFrontWindow } from "./logbook-front-window.js";
export type { FrontWindowProbe, FrontWindowResult } from "./logbook-front-window.js";
export { DESKTOP_PROTECTED_APPS, appListMatches } from "./logbook-skip.js";
