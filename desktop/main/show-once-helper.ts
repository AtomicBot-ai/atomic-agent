import { parseShowOnceProbe, type ShowOnceProbe } from "./show-once-probe.js";
import type { ShowOnceApp } from "./show-once-log.js";

/**
 * ATO-2499 "Show once": the client of the Accessibility helper
 * (native/atomic-show-once.swift, out/native/atomic-show-once; under
 * Resources/native when packaged). One resident process answers every
 * click and key of a recording and pushes the app, window and menu events
 * its AXObserver hears; the old path ran one osascript per event
 * (show-once-probe.ts), which stays as the fallback.
 *
 * The line protocol is in the Swift file's header. No electron import and
 * the process is passed in (`spawn`), so the unit suite drives it with a
 * fake. Never throws: a helper that does not start, says "untrusted", dies
 * or does not answer in time gives `null`, and the caller asks osascript.
 */

export type ShowOnceHelperPush =
  | { kind: "window"; app: ShowOnceApp | null; title: string }
  | { kind: "menu"; app: ShowOnceApp | null; path: string[] };

export type ShowOnceHelperLine =
  | { type: "ready" }
  | { type: "untrusted" }
  | { type: "answer"; id: number; probe: ShowOnceProbe }
  | { type: "push"; push: ShowOnceHelperPush };

/** The slice of a child process the client uses. */
export interface ShowOnceHelperChild {
  stdin: { write(chunk: string): unknown; end(): unknown } | null;
  stdout: { on(event: "data", fn: (chunk: Buffer | string) => void): unknown } | null;
  on(event: "exit" | "error", fn: (...args: unknown[]) => void): unknown;
  kill(): unknown;
}

const appOf = (v: unknown): ShowOnceApp | null => parseShowOnceProbe({ app: v }).app;

/** One stdout line; null for anything the protocol does not say. */
export function parseShowOnceHelperLine(line: string): ShowOnceHelperLine | null {
  let o: unknown;
  try {
    o = JSON.parse(String(line || "").trim());
  } catch {
    return null;
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  if (r.ready === true) return { type: "ready" };
  if (r.untrusted === true) return { type: "untrusted" };
  if (typeof r.id === "number" && Number.isInteger(r.id)) return { type: "answer", id: r.id, probe: parseShowOnceProbe(r) };
  if ((r.ev === "app" || r.ev === "window") && typeof r.title === "string") {
    return { type: "push", push: { kind: "window", app: appOf(r.app), title: r.title.slice(0, 200) } };
  }
  if (r.ev === "menu" && Array.isArray(r.path)) {
    const path = r.path.filter((p): p is string => typeof p === "string" && p.length > 0).map((p) => p.slice(0, 200)).slice(0, 12);
    return path.length ? { type: "push", push: { kind: "menu", app: appOf(r.app), path } } : null;
  }
  return null;
}

export interface ShowOnceHelperOptions {
  spawn: () => ShowOnceHelperChild;
  onPush: (push: ShowOnceHelperPush) => void;
  /** How long `start` waits for "ready" (ms). */
  readyMs?: number;
  /** How long one question waits for its answer (ms). */
  answerMs?: number;
}

export class ShowOnceHelper {
  private child: ShowOnceHelperChild | null = null;
  private alive = false;
  private nextId = 1;
  private buffer = "";
  private readonly waiting = new Map<number, { resolve: (p: ShowOnceProbe | null) => void; timer: NodeJS.Timeout }>();
  private onReady: ((ok: boolean) => void) | null = null;

  constructor(private readonly opts: ShowOnceHelperOptions) {}

  get running(): boolean {
    return this.alive;
  }

  /** Starts the helper; true once it says "ready", false when it cannot listen. */
  start(): Promise<boolean> {
    if (this.alive) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.onReady = null;
        if (!ok) this.stop();
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), this.opts.readyMs ?? 3000);
      this.onReady = done;
      try {
        const child = this.opts.spawn();
        this.child = child;
        child.on("error", () => this.died());
        child.on("exit", () => this.died());
        if (!child.stdout || !child.stdin) return done(false);
        child.stdout.on("data", (chunk) => this.read(String(chunk)));
      } catch {
        done(false);
      }
    });
  }

  /** What is under a click, or behind a key; null when the helper cannot answer. */
  ask(kind: "click" | "key", x = 0, y = 0): Promise<ShowOnceProbe | null> {
    const child = this.child;
    if (!this.alive || !child || !child.stdin) return Promise.resolve(null);
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve(null);
      }, this.opts.answerMs ?? 1500);
      this.waiting.set(id, { resolve, timer });
      try {
        child.stdin!.write(kind === "click" ? `click ${id} ${Math.round(x)} ${Math.round(y)}\n` : `key ${id}\n`);
      } catch {
        this.settle(id, null);
      }
    });
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    this.alive = false;
    for (const id of [...this.waiting.keys()]) this.settle(id, null);
    if (!child) return;
    try { child.stdin?.end(); } catch { /* gone */ }
    try { child.kill(); } catch { /* gone */ }
  }

  private died(): void {
    if (this.onReady) this.onReady(false);
    this.stop();
  }

  private settle(id: number, probe: ShowOnceProbe | null): void {
    const w = this.waiting.get(id);
    if (!w) return;
    this.waiting.delete(id);
    clearTimeout(w.timer);
    w.resolve(probe);
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 1_000_000) this.buffer = ""; // a runaway line: drop it, never grow without end
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      const parsed = parseShowOnceHelperLine(line);
      if (!parsed) continue;
      if (parsed.type === "ready") {
        this.alive = true;
        if (this.onReady) this.onReady(true);
      } else if (parsed.type === "untrusted") {
        if (this.onReady) this.onReady(false);
      } else if (parsed.type === "answer") {
        this.settle(parsed.id, parsed.probe);
      } else if (this.alive) {
        try { this.opts.onPush(parsed.push); } catch { /* the log's problem, not the helper's */ }
      }
    }
  }
}
