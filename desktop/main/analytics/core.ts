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
import { daysSince, DesktopFlagsStore, resolveInstallId, sharedIdPath } from "./identity.js";
import { analyticsEnabledIn, desktopVersion, installChannelFor, readConfigFile, runModeIn } from "./environment.js";
import { PostHogTransport, type QueuedEvent } from "./transport.js";

const UI_ACTION_CAP = 200;

/** A run the test harness drives: nothing leaves the machine, nothing is written to the real home. */
export function isTestRun(argv: readonly string[] = process.argv, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.VITEST !== undefined || env.NODE_ENV === "test") return true;
  if (env.ATOMIC_DESKTOP_ANALYTICS === "off") return true;
  return argv.some((a) =>
    a === "--smoke" || a === "--first-run-probe" || a === "--models"
    || a.startsWith("--smoke-") || a.startsWith("--remote-debugging-port") || a.startsWith("--fake-ram="),
  );
}

interface State {
  stateDir: string;
  tuiStateDir: string;
  testRun: boolean;
  enabled: boolean;
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

export function initAnalytics(opts: { stateDir: string; tuiStateDir: string; testRun?: boolean }): void {
  try {
    S.stateDir = opts.stateDir;
    S.tuiStateDir = opts.tuiStateDir;
    S.testRun = opts.testRun ?? isTestRun();
    const cfg = readConfigFile(opts.stateDir);
    S.enabled = analyticsEnabledIn(cfg);
    S.runMode = runModeIn(cfg);
    S.flags = new DesktopFlagsStore(join(opts.stateDir, "desktop-analytics.json"), () => !S.testRun);
    if (S.flags.get().installedAt === null) S.flags.set({ installedAt: Date.now() });
    transport.start();
  } catch {
    S.enabled = false;
  }
}

/** The shared install id, resolved on first use. Null while analytics is off (nothing needs one). */
export function installId(): string | null {
  if (S.installId) return S.installId;
  if (!S.enabled || !S.stateDir) return null;
  try {
    S.installId = resolveInstallId({
      sharedPath: sharedIdPath(),
      localFiles: [join(S.stateDir, "analytics.json"), join(S.tuiStateDir, "analytics.json")],
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

/** Re-read the run mode from the config file (after a switch, at launch). */
export function refreshRunMode(): "local" | "cloud" | "fusion" | null {
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

export function flushAnalytics(timeoutMs = 2_000): Promise<void> {
  try {
    return transport.flush(timeoutMs).catch(() => undefined);
  } catch {
    return Promise.resolve();
  }
}

/**
 * A config write is about to land (`cli:configSet` / `cli:configUnset`).
 * For `analytics.enabled` going off: `analytics_disabled` goes out first,
 * flushed, and only then does the switch take effect. Going on applies
 * after the write succeeds (`afterAnalyticsWrite`).
 */
export async function beforeAnalyticsWrite(key: string, value: string | null, via: unknown): Promise<void> {
  try {
    if (key !== "analytics.enabled") return;
    const turningOff = value !== null && value.trim().toLowerCase() === "false";
    if (!turningOff || !S.enabled) return;
    const days = daysSince(S.flags?.get().installedAt ?? null);
    track("analytics_disabled", {
      via: via === "slash" || via === "config" ? via : "settings",
      ...(days !== undefined ? { days_since_install: days } : {}),
    });
    await flushAnalytics(2_000);
    setEnabled(false);
  } catch {
    setEnabled(false);
  }
}

/** After the write: the switch reflects what the file now says (a failed write leaves the file as it was). */
export function afterAnalyticsWrite(key: string): void {
  try {
    if (key !== "analytics.enabled") return;
    setEnabled(analyticsEnabledIn(readConfigFile(S.stateDir)));
  } catch {
    /* keep the last state */
  }
}

/** Stop the timer and send what is left, bounded — for the quit path. */
export async function shutdownAnalytics(timeoutMs = 2_000): Promise<void> {
  transport.stop();
  await flushAnalytics(timeoutMs);
}
