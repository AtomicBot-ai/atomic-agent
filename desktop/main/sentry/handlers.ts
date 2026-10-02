/**
 * Where desktop errors are caught. Nothing here changes how the app behaves
 * when something goes wrong:
 *  - main-process exceptions are watched with `uncaughtExceptionMonitor`,
 *    which observes without becoming a handler — Electron's own dialog and
 *    exit stay exactly as they were (it also sees a rejection Node turns
 *    into an exception);
 *  - window and process events are extra listeners beside the existing ones.
 */

import { app, crashReporter, type BrowserWindow } from "electron";

import { analyticsEnabled, desktopVersion, installChannelFor, isTestRun, onAnalyticsEnabledChange, windowCrashed } from "../analytics/index.js";
import { minidumpUrl, reportError } from "./client.js";

/**
 * Electron's crashReporter → Sentry's minidump endpoint. Before
 * app.whenReady, as Electron asks. Upload follows the analytics switch live;
 * a test run starts no reporter at all.
 */
export function startCrashReporter(): void {
  try {
    if (isTestRun()) return;
    const submitURL = minidumpUrl();
    if (!submitURL) return;
    const version = desktopVersion();
    crashReporter.start({
      submitURL,
      uploadToServer: analyticsEnabled(),
      compress: true,
      // Sentry reads `sentry[...]` form fields as event attributes.
      globalExtra: {
        "sentry[tags][surface]": "desktop",
        "sentry[tags][component]": "desktop-shell",
        "sentry[tags][install_channel]": installChannelFor(process.platform, process.env),
        ...(version ? { "sentry[tags][desktop_version]": version, "sentry[release]": `atomic-agent-desktop@${version}` } : {}),
      },
    });
    onAnalyticsEnabledChange((on) => {
      try {
        crashReporter.setUploadToServer(on);
      } catch {
        /* the reporter may not have started */
      }
    });
  } catch {
    /* a crash reporter that cannot start is not a reason not to start the app */
  }
}

/** Main process and app-wide events. Call once, early. */
export function wireProcessErrorReporting(): void {
  process.on("uncaughtExceptionMonitor", (err, origin) => {
    const e = err as Partial<Error> | undefined;
    reportError({ source: origin === "unhandledRejection" ? "unhandledRejection" : "uncaughtException", name: e?.name, message: e?.message, stack: e?.stack });
  });
  app.on("child-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return;
    reportError({
      source: "child-process-gone",
      name: "ChildProcessGone",
      level: "warning",
      tags: { kind: details.type, reason: details.reason, exit_code: details.exitCode },
    });
  });
}

/** One window's renderer: gone, unresponsive, failed load, a preload that threw. */
export function wireWindowErrorReporting(win: BrowserWindow): void {
  const wc = win.webContents;
  wc.on("render-process-gone", (_e, details) => {
    if (details.reason === "clean-exit") return;
    windowCrashed("gone", details.reason, typeof details.exitCode === "number" ? details.exitCode : null);
    reportError({
      source: "render-process-gone",
      name: "RenderProcessGone",
      level: "warning",
      tags: { kind: "gone", reason: details.reason, exit_code: details.exitCode },
    });
  });
  win.on("unresponsive", () => {
    windowCrashed("unresponsive", null, null);
    reportError({ source: "unresponsive", name: "WindowUnresponsive", level: "warning", tags: { kind: "unresponsive" } });
  });
  wc.on("did-fail-load", (_e, errorCode, _description, _url, isMainFrame) => {
    // The code is Chromium's net error number; the description and the URL are never read.
    if (!isMainFrame) return;
    reportError({ source: "did-fail-load", name: "DidFailLoad", level: "warning", tags: { reason: errorCode } });
  });
  wc.on("preload-error", (_e, _preloadPath, error) => {
    reportError({ source: "preload-error", name: error?.name, message: error?.message, stack: error?.stack });
  });
}

/** `errors:report` from the renderer: `{kind, name, message, stack}` — scrubbed like any other. */
export function reportRendererError(payload: unknown): void {
  if (!payload || typeof payload !== "object") return;
  const p = payload as { kind?: unknown; name?: unknown; message?: unknown; stack?: unknown };
  reportError({
    source: "renderer",
    name: p.name,
    message: p.message,
    stack: typeof p.stack === "string" ? p.stack.slice(0, 20_000) : undefined,
    platform: "javascript",
    tags: { kind: p.kind === "unhandledrejection" ? "unhandledrejection" : "error" },
  });
}

/** The agent child exited when nobody stopped it: tags only. */
export function reportAgentExit(detail: { exitCode?: number | null; signal?: string | null; phase?: string }): void {
  reportError({
    source: "agent-exit",
    name: "AgentExited",
    level: "warning",
    tags: { kind: detail.phase ?? "running", exit_code: detail.exitCode ?? undefined, reason: detail.signal ?? undefined },
  });
}
