/**
 * ATO-2534: the logbook's `● Logbook` chip and menu bar icon, on the
 * running agent (src/http/route-logbook.ts):
 *
 *   logbook:status      GET   /api/logbook            the state the chip draws
 *   logbook:act         PATCH /api/logbook/settings   pause (minutes), resume, stop
 *   logbook:chipVisible (send) the window's chip is on screen, or not
 *   app:logbook         (push) a new state, after a poll or a click
 *
 * Main polls every POLL_EVERY_MS and keeps the mark (logbook-mark.ts):
 * the runtime in `atomic-agent serve` captures only while the chip is in
 * a visible window or the menu bar icon is up. A remote agent captures a
 * different computer's screen, so none of this runs for one.
 *
 * Every answer is `{ok:true, view}` or `{ok:false, error}` with `error`
 * in plain words; `view` is null when the agent has no logbook routes.
 */

import { ipcMain, type BrowserWindow } from "electron";

import type { AgentClient } from "./agent-client.js";
import {
  createMarkReporter,
  logbookActionBody,
  logbookErrorText,
  markVisible,
  MARK_EVERY_MS,
  parseLogbookView,
  POLL_EVERY_MS,
  type LogbookChipView,
} from "./logbook-mark.js";

export interface LogbookTrayHandle {
  sync: (view: LogbookChipView | null) => void | Promise<void>;
  shown: () => boolean;
}

export interface LogbookIpcDeps {
  client: Pick<AgentClient, "filesTarget" | "isRemote">;
  window: () => BrowserWindow | null;
  tray: LogbookTrayHandle;
  /** ATO-2526: the screen is locked or the person is away (logbook-away.ts). */
  away?: () => boolean;
}

export type LogbookAnswer = { ok: true; view: LogbookChipView | null } | { ok: false; error: string };

type CallResult = { ok: true; status: number; data: unknown } | { ok: false; status: number; data: unknown };

export interface LogbookControl {
  view: () => LogbookChipView | null;
  act: (action: unknown, minutes?: unknown) => Promise<LogbookAnswer>;
  refresh: () => Promise<LogbookAnswer>;
  call: (method: string, path: string, body?: unknown) => Promise<CallResult>;
  push: (view: LogbookChipView | null) => void;
  /** Tell the runtime about the mark now (a lock or unlock, ATO-2526). */
  beat: () => Promise<void>;
}

export function wireLogbookIpc(deps: LogbookIpcDeps): LogbookControl {
  let current: LogbookChipView | null = null;
  let chipVisible = false;
  let chipReportedAt = 0;

  async function call(method: string, path: string, body?: unknown): Promise<CallResult> {
    let target: { base: string; headers: Record<string, string> };
    try {
      target = deps.client.filesTarget();
    } catch {
      return { ok: false, status: 0, data: null };
    }
    try {
      const res = await fetch(target.base + path, {
        method,
        headers: target.headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
      const text = await res.text();
      let data: unknown = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      return { ok: res.ok, status: res.status, data };
    } catch {
      return { ok: false, status: 0, data: null };
    }
  }

  function push(view: LogbookChipView | null): void {
    current = view;
    void deps.tray.sync(view);
    const win = deps.window();
    if (win && !win.isDestroyed()) win.webContents.send("app:logbook", view);
  }

  async function refresh(): Promise<LogbookAnswer> {
    if (deps.client.isRemote) { push(null); return { ok: true, view: null }; }
    const r = await call("GET", "/api/logbook");
    // An agent from before the routes: no chip, no icon.
    if (r.status === 404) { push(null); return { ok: true, view: null }; }
    if (!r.ok) return { ok: false, error: logbookErrorText(r.status, r.data) };
    const view = parseLogbookView(r.data);
    push(view);
    return { ok: true, view };
  }

  async function act(action: unknown, minutes?: unknown): Promise<LogbookAnswer> {
    const body = logbookActionBody(action, minutes);
    if (!body) return { ok: false, error: "That is not a logbook action." };
    if (deps.client.isRemote) return { ok: false, error: "The logbook is changed on the computer it runs on." };
    const r = await call("PATCH", "/api/logbook/settings", body);
    if (!r.ok) return { ok: false, error: logbookErrorText(r.status, r.data) };
    const view = parseLogbookView(r.data);
    push(view);
    void beat();
    return { ok: true, view };
  }

  const reporter = createMarkReporter((mark) => call("POST", "/api/logbook/indicator", mark));
  async function beat(): Promise<void> {
    if (deps.client.isRemote) return;
    const visible = markVisible({ chipVisible, chipReportedAt, trayShown: deps.tray.shown(), now: Date.now() });
    await reporter.beat({ state: current?.state ?? null, visible, away: deps.away?.() ?? false });
  }

  ipcMain.handle("logbook:status", () => (current ? { ok: true, view: current } : refresh()));
  ipcMain.handle("logbook:act", (_event, action: unknown, minutes: unknown) => act(action, minutes));
  ipcMain.on("logbook:chipVisible", (_event, visible: unknown) => {
    const was = chipVisible;
    chipVisible = visible === true;
    chipReportedAt = Date.now();
    if (was !== chipVisible) void beat();
  });

  const poll = setInterval(() => { void refresh().then(beat); }, POLL_EVERY_MS);
  const mark = setInterval(() => { void beat(); }, MARK_EVERY_MS);
  poll.unref?.();
  mark.unref?.();
  void refresh().then(beat);

  return { view: () => current, act, refresh, call, push, beat };
}
