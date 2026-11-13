import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ImsgMessage } from "./imsg-event.js";
import type { ImsgFailure } from "./imsg-errors.js";
import { ImsgWatcher, type WatchChild } from "./imsg-watch.js";

class FakeStream extends EventEmitter {
  setEncoding(): this {
    return this;
  }
}

class FakeChild extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  killed: string[] = [];
  kill(signal?: NodeJS.Signals): boolean {
    this.killed.push(signal ?? "SIGTERM");
    return true;
  }
  line(obj: unknown): void {
    this.stdout.emit("data", `${JSON.stringify(obj)}\n`);
  }
}

function setup(overrides: { now?: () => number } = {}) {
  const children: FakeChild[] = [];
  const argvs: string[][] = [];
  const messages: ImsgMessage[] = [];
  const exits: ImsgFailure[] = [];
  const fatals: ImsgFailure[] = [];
  let running = 0;
  const watcher = new ImsgWatcher({
    binary: "imsg",
    onMessage: (m) => messages.push(m),
    onRunning: () => (running += 1),
    onExit: (f) => exits.push(f),
    onFatal: (f) => fatals.push(f),
    spawnImpl: (_file, args) => {
      argvs.push([...args]);
      const child = new FakeChild();
      children.push(child);
      return child as unknown as WatchChild;
    },
    delayMs: () => 1000,
    ...overrides,
  });
  return { watcher, children, argvs, messages, exits, fatals, running: () => running };
}

const msg = (id: number) => ({ id, chat_id: 1, sender: "+1", is_from_me: false, text: `m${id}`, attachments: [] });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("ImsgWatcher", () => {
  it("spawns `imsg watch --json` and forwards parsed messages", () => {
    const t = setup();
    t.watcher.start();
    expect(t.argvs[0]).toEqual(["watch", "--json"]);
    t.children[0]!.emit("spawn");
    expect(t.running()).toBe(1);
    t.children[0]!.line(msg(5));
    t.children[0]!.stdout.emit("data", "not json\n");
    expect(t.messages.map((m) => m.rowId)).toEqual([5]);
  });

  it("restarts after an exit, resuming after the last rowid", () => {
    const t = setup();
    t.watcher.start();
    t.children[0]!.line(msg(7));
    t.children[0]!.stderr.emit("data", "Error: unable to open database file\n");
    t.children[0]!.emit("close", 1, null);
    expect(t.exits.map((e) => e.kind)).toEqual(["disk-access"]);
    expect(t.children).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(t.children).toHaveLength(2);
    expect(t.argvs[1]).toEqual(["watch", "--json", "--since-rowid", "7"]);
  });

  it("treats a missing binary as fatal and does not retry", () => {
    const t = setup();
    t.watcher.start();
    const err = Object.assign(new Error("spawn imsg ENOENT"), { code: "ENOENT" });
    t.children[0]!.emit("error", err);
    t.children[0]!.emit("close", -2, null);
    expect(t.fatals.map((f) => f.kind)).toEqual(["missing"]);
    expect(t.exits).toEqual([]);
    vi.advanceTimersByTime(120_000);
    expect(t.children).toHaveLength(1);
  });

  it("treats any error before spawn (not executable) as fatal", () => {
    const t = setup();
    t.watcher.start();
    t.children[0]!.emit("error", Object.assign(new Error("spawn imsg EACCES"), { code: "EACCES" }));
    expect(t.fatals.map((f) => f.kind)).toEqual(["other"]);
    vi.advanceTimersByTime(120_000);
    expect(t.children).toHaveLength(1);
  });

  it("stop() kills the child, cancels the restart and ignores late output", () => {
    const t = setup();
    t.watcher.start();
    const first = t.children[0]!;
    first.emit("close", 1, null);
    t.watcher.stop();
    vi.advanceTimersByTime(120_000);
    expect(t.children).toHaveLength(1);

    t.watcher.start();
    const second = t.children[1]!;
    t.watcher.stop();
    t.watcher.stop();
    expect(second.killed).toEqual(["SIGTERM"]);
    second.line(msg(9));
    second.emit("close", null, "SIGTERM");
    expect(t.messages).toEqual([]);
    expect(t.exits).toHaveLength(1);
  });
});
