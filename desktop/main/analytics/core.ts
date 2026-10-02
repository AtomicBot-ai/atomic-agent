/**
 * The desktop's analytics client: the live gate on `analytics.enabled`, the
 * shared install id, the global properties, the renderer's channel (with the
 * `ui_action` cap) and the PostHog transport behind them.
 *
 * Every entry point is safe to call before init() and never throws: a
 * failure in here must never become a failure of the app.
 */

import { join } from "node:path";

import { validateEvent, type Props } from "./validate.js";
import { daysSince, DesktopFlagsStore, resolveInstallId, seedDesktopFlags, sharedIdPath } from "./identity.js";
import {
  analyticsEnabledFor, desktopVersion, explicitAnalyticsEnabled, inheritedOptOut, installChannelFor, isTestRun,
  readConfigFile, runModeIn, setAgentGate,
} from "./environment.js";
import { writeAnalyticsSwitch } from "./opt-out.js";
import { PostHogTransport, type QueuedEvent } from "./transport.js";

const UI_ACTION_CAP = 200;
/** The quit drains at most this many batches (of 100) inside its 2 s. */
const QUIT_BATCHES = 5;

export { isTestRun };

interface State {
  stateDir: string;
  tuiStateDir: string;
  testRun: boolean;
  enabled: boolean;
  /** The terminal agent's config said analytics.enabled false and the desktop's says nothing. */
  inheritedOff: boolean;
  /** The terminal agent's config opted out: its analytics.json id is not adopted. */
  tuiOptedOut: boolean;
  installId: string | null;
  flags: DesktopFlagsStore | null;
  runMode: "local" | "cloud" | "fusion" | null;
  uiActions: number;
}

const S: State = {
  stateDir: "",
  tuiStateDir: "",
  testRun: true,
  enabled: false,
  inheritedOff: false,
  tuiOptedOut: false,
  installId: null,
  flags: null,
  runMode: null,
  uiActions: 0,
};

const enabledListeners: Array<(on: boolean) => void> = [];

const transport = new PostHogTransport({
  canSend: () => S.enabled && !S.testRun,
  distinctId: () => installId(),
  echo: process.env.ATOMIC_DESKTOP_ANALYTICS_LOG === "1"
    ? (e: QueuedEvent) => process.stderr.write(`[analytics] ${e.event} ${JSON.stringify(e.properties)}\n`)
    : undefined,
});

/** Read both config files and set the gate from them (init, and after every analytics.enabled write). */
function readGate(): boolean {
  const cfg = readConfigFile(S.stateDir);
  const tuiCfg = readConfigFile(S.tuiStateDir);
  S.inheritedOff = inheritedOptOut(cfg, tuiCfg);
  S.tuiOptedOut = explicitAnalyticsEnabled(tuiCfg) === false;
  return analyticsEnabledFor(cfg, tuiCfg);
}

/**
 * Call once, at module level in main.ts, BEFORE the agent is spawned: the
 * install id is resolved here, so the agent's first run finds the shared
 * file already written and adopts the same id.
 */
export function initAnalytics(opts: { stateDir: string; tuiStateDir: string; freshState: boolean; testRun?: boolean }): void {
  try {
    S.stateDir = opts.stateDir;
    S.tuiStateDir = opts.tuiStateDir;
    S.testRun = opts.testRun ?? isTestRun();
    setAgentGate(() => ({ testRun: S.testRun, inheritedOff: S.inheritedOff }));
    S.enabled = readGate();
    S.flags = new DesktopFlagsStore(join(opts.stateDir, "desktop-analytics.json"), () => !S.testRun);
    seedDesktopFlags(S.flags, opts.freshState);
    if (S.enabled) {
      S.runMode = runModeIn(readConfigFile(opts.stateDir));
      installId();
    }
    transport.start();
  } catch {
    S.enabled = false;
  }
}

/**
 * Where an install id is adopted from, in order (the shared file is read
 * before all of them): the terminal agent's analytics.json, unless its
 * config opted out, then the desktop state dir's.
 */
export function installIdSources(tuiStateDir: string, stateDir: string, tuiOptedOut: boolean): string[] {
  return [...(tuiOptedOut ? [] : [join(tuiStateDir, "analytics.json")]), join(stateDir, "analytics.json")];
}

/** The shared install id. Null while analytics is off (nothing needs one). */
export function installId(): string | null {
  if (S.installId) return S.installId;
  if (!S.enabled || !S.stateDir) return null;
  try {
    S.installId = resolveInstallId({
      sharedPath: sharedIdPath(),
      localFiles: installIdSources(S.tuiStateDir, S.stateDir, S.tuiOptedOut),
      // Tests and dev runs never write to the real home.
      allowWrite: !S.testRun,
    }).id;
  } catch {
    S.installId = null;
  }
  return S.installId;
}

export function analyticsEnabled(): boolean {
  return S.enabled;
}

export function sendingAllowed(): boolean {
  return S.enabled && !S.testRun;
}

export function flagsStore(): DesktopFlagsStore | null {
  return S.flags;
}

/** Subscribe to the live switch (the crash reporter's upload follows it). */
export function onAnalyticsEnabledChange(cb: (on: boolean) => void): void {
  enabledListeners.push(cb);
}

function setEnabled(on: boolean): void {
  if (S.enabled === on) return;
  S.enabled = on;
  if (!on) transport.clear();
  else refreshRunMode();   // not read while it was off
  for (const cb of enabledListeners) {
    try {
      cb(on);
    } catch {
      /* a listener's failure is not the switch's */
    }
  }
}

export function globalProps(): Props {
  return {
    surface: "desktop",
    platform: process.platform,
    arch: process.arch,
    desktop_version: desktopVersion(),
    install_channel: installChannelFor(process.platform, process.env),
    ...(S.runMode ? { run_mode: S.runMode } : {}),
  };
}

export function currentRunMode(): "local" | "cloud" | "fusion" | null {
  return S.runMode;
}

/** Re-read the run mode from the config file (after a switch, at launch). No read while analytics is off. */
export function refreshRunMode(): "local" | "cloud" | "fusion" | null {
  if (!S.enabled) return S.runMode;
  try {
    S.runMode = runModeIn(readConfigFile(S.stateDir));
  } catch {
    /* keep the last one */
  }
  return S.runMode;
}

/** Main-process events. Validated like the renderer's; global props win over the caller's. */
export function track(event: string, props: Props = {}): void {
  try {
    if (!S.enabled) return;
    const v = validateEvent(event, props, "main");
    if (!v) return;
    transport.enqueue(v.event, { ...v.props, ...globalProps() });
  } catch {
    /* never */
  }
}

/** `analytics:track` from the renderer: UI-owned events only, `ui_action` capped per app session. */
export function trackFromRenderer(payload: unknown): void {
  try {
    if (!S.enabled || !payload || typeof payload !== "object") return;
    const { event, props } = payload as { event?: unknown; props?: unknown };
    const v = validateEvent(event, props, "ui");
    if (!v) return;
    if (v.event === "ui_action") {
      // An action the renderer could not name is noise, not usage: dropped, and not counted.
      if (typeof v.props.action !== "string" || v.props.action === "other") return;
      if (S.uiActions >= UI_ACTION_CAP) return;
      S.uiActions += 1;
    }
    transport.enqueue(v.event, { ...v.props, ...globalProps() });
  } catch {
    /* never */
  }
}

/** Send what is queued; the whole thing (an in-flight batch included) resolves within `timeoutMs`. */
export function flushAnalytics(timeoutMs = 2_000, maxBatches = 1): Promise<void> {
  try {
    return transport.flush(timeoutMs, maxBatches).catch(() => undefined);
  } catch {
    return Promise.resolve();
  }
}

/**
 * Any config write from the window (`cli:configSet` / `cli:configUnset`).
 * For `analytics.enabled` (opt-out.ts): the write first; only after it
 * succeeded, `analytics_disabled` + a bounded flush when going off, then the
 * live switch follows the files. Every other key is just the write.
 */
export function analyticsConfigWrite<T>(key: string, value: string | null, via: unknown, write: () => Promise<T>): Promise<T> {
  return writeAnalyticsSwitch(key, value, via, write, {
    enabledNow: () => S.enabled,
    enabledInFiles: () => readGate(),
    announceDisabled: (v) => {
      const days = daysSince(S.flags?.get().installedAt ?? null);
      track("analytics_disabled", { via: v, ...(days !== undefined ? { days_since_install: days } : {}) });
    },
    flush: () => flushAnalytics(2_000),
    setEnabled,
  });
}

/** Stop the timer and drain what is left (up to 5 batches), bounded — for the quit path. */
export async function shutdownAnalytics(timeoutMs = 2_000): Promise<void> {
  transport.stop();
  await flushAnalytics(timeoutMs, QUIT_BATCHES);
}
