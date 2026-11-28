import { logbookCaptureOptions, type LogbookCaptureOptions, type LogbookCaptureOutcome } from "./logbook-capture.js";
import type { IndicatorState } from "./logbook-indicator.js";
import type { LogbookVisionProvider, PickLocalVisionResult } from "./logbook-local-vision.js";
import { logbookCapturing, readLogbookSettings, type LogbookSettings } from "./logbook-settings.js";
import { readLogbookStatus, writeLogbookStatus, type LogbookStatus } from "./logbook-status.js";
import { appendLogbookEntry, pruneLogbook, type LogbookEntry } from "./logbook-store.js";

/**
 * The logbook's loop as a scheduler sidecar (`src/scheduler`): it is
 * ticked every scheduler interval (5 s by default) in the one process
 * that leads, so the desktop's `atag serve` and a TUI on the same state
 * dir never both take screenshots. Each tick re-reads settings.json:
 * `logbook stop` or `pause` holds from the next tick, and a frame whose
 * description finishes after a stop is dropped, not stored. Retention
 * is applied once an hour whether the logbook is on or off.
 *
 * `indicator` (ATO-2534) is how a process whose frontend is not the TUI
 * learns that the recording mark is on screen: no capture while it is
 * `hidden`, a recorded skip while the person is `away`, and a frame
 * whose mark went away while it was described is dropped. Left out (the
 * TUI, whose top bar always shows the chip) the mark counts as visible.
 */
/** Status text while the mark is not on screen. */
export const INDICATOR_HIDDEN_REASON =
  "the Logbook mark is not on screen (open the desktop app or the terminal app), so nothing is captured";
/** Status text while the person is idle or the screen is locked. */
export const INDICATOR_AWAY_REASON = "you were away or the screen was locked, so nothing was captured";

export const PRUNE_EVERY_MS = 60 * 60 * 1000;

export interface LogbookSidecarDeps {
  stateDir: string;
  /** The local vision provider for this frame, looked up on every capture. */
  resolveProvider: () => PickLocalVisionResult;
  capture: (provider: LogbookVisionProvider, options: LogbookCaptureOptions, signal: AbortSignal) => Promise<LogbookCaptureOutcome>;
  /** Removes frames a crash left behind; run before the first capture. */
  sweepFrames?: () => Promise<void>;
  logger?: { warn(message: string, data?: Record<string, unknown>): void };
  /** Whether the recording mark is on screen; omitted means always (the TUI). */
  indicator?: (now: number) => IndicatorState;
  /** Test seams; default to the files under `<stateDir>/logbook`. */
  readSettings?: (stateDir: string) => LogbookSettings;
  readStatus?: (stateDir: string) => LogbookStatus;
  writeStatus?: (stateDir: string, status: LogbookStatus) => void;
  append?: (stateDir: string, entry: LogbookEntry) => void;
  prune?: (stateDir: string, retentionDays: number, now: Date) => string[];
}

export interface LogbookSidecar {
  tick(now: number, signal: AbortSignal): Promise<void>;
  /** True while a frame is being taken or described. */
  busy(): boolean;
}

export function createLogbookSidecar(deps: LogbookSidecarDeps): LogbookSidecar {
  const readSettings = deps.readSettings ?? readLogbookSettings;
  const readStatus = deps.readStatus ?? readLogbookStatus;
  const writeStatus = deps.writeStatus ?? writeLogbookStatus;
  const append = deps.append ?? appendLogbookEntry;
  const prune = deps.prune ?? pruneLogbook;
  let inFlight = false;
  let lastAttemptAt: number | null = null;
  let lastPruneAt: number | null = null;
  let swept = false;
  let hiddenNoted = false;
  const indicator: (now: number) => IndicatorState = deps.indicator ?? (() => "visible");

  const record = (patch: Partial<LogbookStatus>) => {
    try {
      writeStatus(deps.stateDir, { ...readStatus(deps.stateDir), ...patch });
    } catch (err) {
      deps.logger?.warn("logbook: status write failed", { error: errorText(err) });
    }
  };

  return {
    busy: () => inFlight,
    async tick(now, signal) {
      if (inFlight || signal.aborted) return;
      const settings = readSettings(deps.stateDir);
      if (lastPruneAt === null || now - lastPruneAt >= PRUNE_EVERY_MS) {
        lastPruneAt = now;
        try {
          prune(deps.stateDir, settings.retentionDays, new Date(now));
        } catch (err) {
          deps.logger?.warn("logbook: retention prune failed", { error: errorText(err) });
        }
      }
      if (!logbookCapturing(settings, now)) return;
      if (lastAttemptAt !== null && now - lastAttemptAt < settings.intervalMinutes * 60_000) return;
      const mark = indicator(now);
      // Not on screen: wait without using up the interval, so a frame is taken soon after it shows.
      if (mark === "hidden") {
        if (!hiddenNoted) record({ lastAttemptAt: now, lastOutcome: "skipped", lastReason: INDICATOR_HIDDEN_REASON });
        hiddenNoted = true;
        return;
      }
      hiddenNoted = false;
      lastAttemptAt = now;
      if (mark === "away") {
        record({ lastAttemptAt: now, lastOutcome: "skipped", lastReason: INDICATOR_AWAY_REASON });
        return;
      }
      inFlight = true;
      try {
        if (!swept) {
          swept = true;
          await deps.sweepFrames?.().catch(() => undefined);
        }
        const pick = deps.resolveProvider();
        if (!pick.ok) {
          record({ lastAttemptAt: now, lastOutcome: "skipped", lastReason: pick.reason, provider: null });
          return;
        }
        const outcome = await deps.capture(pick.provider, logbookCaptureOptions(settings), signal);
        if (outcome.kind !== "captured") {
          record({ lastAttemptAt: now, lastOutcome: outcome.kind, lastReason: outcome.reason, provider: pick.provider.id });
          return;
        }
        // Stopped, paused or shut down while the model was describing: keep nothing.
        if (signal.aborted || !logbookCapturing(readSettings(deps.stateDir), Date.now()) || indicator(Date.now()) !== "visible") {
          record({ lastAttemptAt: now, lastOutcome: "skipped", lastReason: "the logbook was stopped while the frame was described", provider: pick.provider.id });
          return;
        }
        append(deps.stateDir, outcome.entry);
        record({ lastAttemptAt: now, lastCaptureAt: now, lastOutcome: "captured", lastReason: null, provider: pick.provider.id });
      } catch (err) {
        record({ lastAttemptAt: now, lastOutcome: "error", lastReason: errorText(err) });
        deps.logger?.warn("logbook: capture failed", { error: errorText(err) });
      } finally {
        inFlight = false;
      }
    },
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
