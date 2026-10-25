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
import { freeMemoryBucket, lastErrorCategory, uptimeBucket, windowsExitStatus } from "./exit-reason.js";

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

/**
 * One window's renderer: gone, unresponsive, failed load, a preload that threw.
 * `recovered` (ATO-765): whether main is reloading the page that just went
 * (main.ts registers that listener first), sent as the `recovered` tag.
 */
export function wireWindowErrorReporting(win: BrowserWindow, recovered: () => boolean | null = () => null): void {
  const wc = win.webContents;
  wc.on("render-process-gone", (_e, details) => {
    if (details.reason === "clean-exit") return;
    windowCrashed("gone", details.reason, typeof details.exitCode === "number" ? details.exitCode : null);
    const r = recovered();
    reportError({
      source: "render-process-gone",
      name: "RenderProcessGone",
      level: "warning",
      tags: { kind: "gone", reason: details.reason, exit_code: details.exitCode, ...(r === null ? {} : { recovered: r ? "yes" : "no" }) },
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

/**
 * The agent child exited when nobody stopped it: tags only. ATO-763: also
 * `last_error` (a category of its last error lines, exit-reason.ts; the lines
 * themselves are never sent), `uptime` as a bucket, and on Windows
 * `sentinel_alive`: whether the stand-in it watches was still up. A dead
 * sentinel means the agent closed itself on `--parent-pid`, not a crash.
 */
export function reportAgentExit(
  detail: { exitCode?: number | null; signal?: string | null; phase?: string; uptimeMs?: number | null; sentinelAlive?: boolean | null },
  lastLines: readonly string[] = [],
  /** ATO-424: the machine at the exit — free memory in bytes, and whether the app was already quitting. */
  machine: { freeMemBytes?: number | null; quitting?: boolean } = {},
): void {
  const sentinel = typeof detail.sentinelAlive === "boolean" ? (detail.sentinelAlive ? "yes" : "no") : undefined;
  const status = windowsExitStatus(detail.exitCode);
  const freeMem = freeMemoryBucket(machine.freeMemBytes);
  // An exit 0 with no signal is the agent ending on its own terms (a stop it was sent), not a crash: kept, as info.
  const clean = detail.exitCode === 0 && !detail.signal;
  reportError({
    source: "agent-exit",
    name: "AgentExited",
    level: clean ? "info" : "warning",
    tags: {
      ...(status ? { exit_status: status } : {}),
      ...(freeMem ? { free_mem: freeMem } : {}),
      ...(typeof machine.quitting === "boolean" ? { app_quitting: machine.quitting ? "yes" : "no" } : {}),
      kind: detail.phase ?? "running",
      exit_code: detail.exitCode ?? undefined,
      reason: detail.signal ?? undefined,
      last_error: lastErrorCategory(lastLines),
      uptime: uptimeBucket(detail.uptimeMs) ?? undefined,
      ...(sentinel ? { sentinel_alive: sentinel } : {}),
    },
  });
}
