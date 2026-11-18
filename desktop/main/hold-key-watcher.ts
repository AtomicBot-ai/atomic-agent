import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

import { LineBuffer, parseHoldKeyLine, type HoldKeyLine, type HoldWatchState, type WatcherCommand } from "./dictate-hold.js";

/**
 * ATO-1064: the hold key watcher's process (dictate-hold.ts has the
 * protocol and the command). Spawned hidden, read line by line, killed on
 * stop. Its stdin stays open and unused: the watcher exits when it closes,
 * so a crashed app does not leave a keyboard hook behind.
 */
export class HoldKeyWatcher {
  private child: ChildProcess | null = null;
  private st: HoldWatchState = "off";
  private why: string | null = null;
  private restarts = 0;
  private restartTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly command: () => WatcherCommand | null,
    private readonly onKey: (line: HoldKeyLine) => void,
    private readonly onState: (st: HoldWatchState) => void,
    private readonly log: (line: string) => void,
  ) {}

  get state(): HoldWatchState {
    return this.st;
  }

  /** The last error line, for Settings. */
  get detail(): string | null {
    return this.why;
  }

  /** Starts it unless it runs (or is starting). A failed or untrusted one is tried again. */
  start(): void {
    if (this.child) return;
    const cmd = this.command();
    if (!cmd || (cmd.file.includes("/") && !existsSync(cmd.file))) { this.set("missing"); return; }
    this.why = null;
    this.set("starting");
    let child: ChildProcess;
    try {
      child = spawn(cmd.file, cmd.args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      this.why = err instanceof Error ? err.message : String(err);
      this.set("failed");
      return;
    }
    this.child = child;
    const lines = new LineBuffer();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      for (const raw of lines.push(chunk)) {
        const line = parseHoldKeyLine(raw);
        if (!line || this.child !== child) continue;
        if (line.type === "ready") { this.restarts = 0; this.set("ready"); continue; }
        if (line.type === "untrusted") { this.set("untrusted"); continue; }
        if (line.type === "error") { this.why = line.message; this.log(`[desktop] hold key watcher: ${line.message}`); continue; }
        this.onKey(line);
      }
    });
    child.stderr?.on("data", () => { /* PowerShell's progress noise; errors come as `error` lines */ });
    child.stdin?.on("error", () => { /* closed under us */ });
    child.on("error", (err) => {
      if (this.child !== child) return;
      this.child = null;
      this.why = err.message;
      this.set((err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "failed");
    });
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.child = null;
      const wasReady = this.st === "ready";
      if (this.st !== "untrusted") {
        this.why = this.why ?? `exit code ${code ?? "?"}`;
        this.set("failed");
      }
      // A watcher that was working and crashed gets a few more tries on its own.
      if (wasReady && this.restarts < 3) {
        this.restarts += 1;
        this.restartTimer = setTimeout(() => { this.restartTimer = null; this.start(); }, 2000 * this.restarts);
      }
    });
  }

  stop(): void {
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    const c = this.child;
    this.child = null;
    if (c) {
      try { c.stdin?.end(); } catch { /* gone */ }
      try { c.kill(); } catch { /* gone */ }
    }
    this.set("off");
  }

  private set(st: HoldWatchState): void {
    if (this.st === st) return;
    this.st = st;
    this.onState(st);
  }
}
