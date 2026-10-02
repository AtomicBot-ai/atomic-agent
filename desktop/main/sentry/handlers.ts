/**
 * Where desktop errors are caught. Every report is a scrubbed envelope
 * (client.ts): an error type, sanitized stack frames and enum tags. There is
 * deliberately no Electron crashReporter: a minidump carries process memory
 * (chat text, keys) and absolute module paths, which no scrubbing on this
 * side can take out. Nothing here changes how the app behaves when something
 * goes wrong:
 *  - main-process exceptions are watched with `uncaughtExceptionMonitor`,
 *    which observes without becoming a handler — Electron's own dialog and
 *    exit stay exactly as they were (it also sees a rejection Node turns
 *    into an exception);
 *  - window and process events are extra listeners beside the existing ones.
 */

import { app, type BrowserWindow } from "electron";

import { windowCrashed } from "../analytics/index.js";
import { reportError } from "./client.js";

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
