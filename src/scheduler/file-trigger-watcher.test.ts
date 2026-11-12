import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import type { FileTriggerConfig } from "../config/file-trigger-config.js";
import { StructuredLogger, type LogRecord } from "../tracing/structured-logger.js";
import { FileTriggerWatcher } from "./file-trigger-watcher.js";
import {
  fakeWatcherFactory,
  manualClock,
  memoryFs,
  recorder,
  triggerConfig,
} from "./file-trigger-test-helpers.js";

const ROOT = resolve("/data/inbox");

function setup(overrides: Partial<FileTriggerConfig> = {}, rootIsFile = false) {
  const { factory, watches } = fakeWatcherFactory();
  const disk = memoryFs();
  const time = manualClock();
  const out = recorder();
  const records: LogRecord[] = [];
  const stops: string[] = [];
  const config = triggerConfig({ path: ROOT, ...overrides });
  const watcher = new FileTriggerWatcher({
    name: "inbox",
    config,
    root: ROOT,
    rootIsFile,
    factory,
    fs: disk.fs,
    clock: time.clock,
    fire: out.fire,
    logger: new StructuredLogger({ level: "debug", sinks: [(r) => records.push(r)] }),
    onSelfStop: (_name, reason) => stops.push(reason),
  });
  watcher.start();
  const watch = watches[0]!;
  const emit = (kind: "add" | "change" | "unlink", path: string) => watch.listeners.onEvent(kind, path);
  const settle = async () => {
    time.flush();
    await watcher.whenIdle();
  };
  return { watcher, watch, disk, time, out, records, stops, emit, settle };
}

describe("FileTriggerWatcher", () => {
  it("never fires for files already there, then fires once per new file after the debounce", async () => {
    const t = setup();
    const old = join(ROOT, "old.pdf");
    t.disk.write(old, "old");
    t.emit("add", old);
    t.watch.listeners.onReady();
    await t.settle();
    expect(t.out.fired).toEqual([]);

    const fresh = join(ROOT, "invoice.pdf");
    t.disk.write(fresh, "%PDF");
    t.emit("add", fresh);
    expect(t.out.fired).toEqual([]);
    expect(t.time.delays).toEqual([250]);
    await t.settle();
    expect(t.out.fired).toEqual([{ trigger: "inbox", userMessage: "add invoice.pdf" }]);
  });

  it("coalesces a burst of events for one file into one task", async () => {
    const t = setup({ events: ["add", "change"] });
    t.watch.listeners.onReady();
    const file = join(ROOT, "big.pdf");
    t.disk.write(file, "part");
    t.emit("add", file);
    t.disk.append(file, "more");
    t.emit("change", file);
    t.emit("change", file);
    expect(t.time.pending()).toBe(1);
    await t.settle();
    expect(t.out.fired.map((f) => f.userMessage)).toEqual(["add big.pdf"]);
  });

  it("dedupes a repeat with the same mtime and size, fires again when the file changed", async () => {
    const t = setup({ events: ["add", "change"] });
    t.watch.listeners.onReady();
    const file = join(ROOT, "a.pdf");
    t.disk.write(file, "one", 10);
    t.emit("add", file);
    await t.settle();
    t.emit("change", file);
    await t.settle();
    expect(t.out.fired).toHaveLength(1);
    t.disk.write(file, "one two", 11);
    t.emit("change", file);
    await t.settle();
    expect(t.out.fired.map((f) => f.userMessage)).toEqual(["add a.pdf", "change a.pdf"]);
  });

  it("ignores event kinds the trigger did not ask for", async () => {
    const t = setup({ events: ["add"] });
    t.watch.listeners.onReady();
    const file = join(ROOT, "a.pdf");
    t.disk.write(file, "x");
    t.emit("change", file);
    await t.settle();
    expect(t.out.fired).toEqual([]);
    expect(t.time.delays).toEqual([]);
  });

  it("applies the glob and skips node_modules and .git", async () => {
    const t = setup({ glob: "*.pdf" });
    const { ignored } = t.watch.options;
    expect(ignored(join(ROOT, "note.txt"), false)).toBe(true);
    expect(ignored(join(ROOT, "doc.pdf"), false)).toBe(false);
    expect(ignored(join(ROOT, "sub"), true)).toBe(false);
    expect(ignored(join(ROOT, "node_modules"), true)).toBe(true);
    expect(ignored(join(ROOT, ".git", "HEAD"), undefined)).toBe(true);
    t.watch.listeners.onReady();
    t.disk.write(join(ROOT, "note.txt"), "x");
    t.emit("add", join(ROOT, "note.txt"));
    await t.settle();
    expect(t.out.fired).toEqual([]);
    expect(t.watch.options.depth).toBe(2);
  });

  it("stops itself with a warning past maxFiles", async () => {
    const t = setup({ maxFiles: 2 });
    for (const name of ["a", "b", "c"]) t.emit("add", join(ROOT, name));
    expect(t.watcher.isStopped).toBe(true);
    expect(t.stops).toEqual(["more than 2 files under the watched path (maxFiles)"]);
    expect(t.records.find((r) => r.message === "file trigger stopped")?.context).toMatchObject({
      trigger: "inbox",
      reason: "more than 2 files under the watched path (maxFiles)",
    });
    await t.watcher.stop();
    expect(t.watch.closed).toBe(true);
    t.watch.listeners.onReady();
    t.disk.write(join(ROOT, "d"), "x");
    t.emit("add", join(ROOT, "d"));
    await t.settle();
    expect(t.out.fired).toEqual([]);
  });

  it("stops itself on a watcher error", () => {
    const t = setup();
    t.watch.listeners.onError(new Error("EMFILE: too many open files"));
    expect(t.watcher.isStopped).toBe(true);
    expect(t.stops).toEqual(["watcher error: EMFILE: too many open files"]);
  });

  it("a deleted file cancels its pending debounce", async () => {
    const t = setup();
    t.watch.listeners.onReady();
    const file = join(ROOT, "gone.pdf");
    t.disk.write(file, "x");
    t.emit("add", file);
    t.emit("unlink", file);
    expect(t.time.pending()).toBe(0);
    await t.settle();
    expect(t.out.fired).toEqual([]);
  });

  it("stop clears pending debounces and closes the watcher", async () => {
    const t = setup();
    t.watch.listeners.onReady();
    t.disk.write(join(ROOT, "a.pdf"), "x");
    t.emit("add", join(ROOT, "a.pdf"));
    await t.watcher.stop();
    expect(t.time.pending()).toBe(0);
    expect(t.watch.closed).toBe(true);
    await t.settle();
    expect(t.out.fired).toEqual([]);
  });

  it("passes a fixed sessionId through", async () => {
    const t = setup({ sessionId: "inbox-session" });
    t.watch.listeners.onReady();
    t.disk.write(join(ROOT, "a.pdf"), "x");
    t.emit("add", join(ROOT, "a.pdf"));
    await t.settle();
    expect(t.out.fired[0]?.sessionId).toBe("inbox-session");
  });
});

describe("FileTriggerWatcher with contains (log lines)", () => {
  const LOG = resolve("/var/log/app.log");

  function logSetup() {
    const t = setupLog();
    t.disk.write(LOG, "boot ERROR from before\n");
    t.emit("add", LOG);
    t.watch.listeners.onReady();
    return t;
  }

  function setupLog() {
    const { factory, watches } = fakeWatcherFactory();
    const disk = memoryFs();
    const time = manualClock();
    const out = recorder();
    const watcher = new FileTriggerWatcher({
      name: "errors",
      config: triggerConfig({
        path: LOG,
        events: ["change"],
        contains: "ERROR",
        userMessageTemplate: "New errors in {{name}}:\n{{lines}}",
      }),
      root: LOG,
      rootIsFile: true,
      factory,
      fs: disk.fs,
      clock: time.clock,
      fire: out.fire,
    });
    watcher.start();
    const watch = watches[0]!;
    return {
      watcher,
      watch,
      disk,
      out,
      emit: (kind: "add" | "change", path: string) => watch.listeners.onEvent(kind, path),
      settle: async () => {
        time.flush();
        await watcher.whenIdle();
      },
    };
  }

  it("watches a single file at depth 0 and ignores the glob", () => {
    const t = setupLog();
    expect(t.watch.options.depth).toBe(0);
    expect(t.watch.options.ignored(LOG, false)).toBe(false);
  });

  it("fires only for new matching lines, never for old ones", async () => {
    const t = logSetup();
    await t.settle();
    t.disk.append(LOG, "all fine\n");
    t.emit("change", LOG);
    await t.settle();
    expect(t.out.fired).toEqual([]);

    t.disk.append(LOG, "ERROR disk full\nok\nERROR again\n");
    t.emit("change", LOG);
    await t.settle();
    expect(t.out.fired.map((f) => f.userMessage)).toEqual([
      "New errors in app.log:\nERROR disk full\nERROR again",
    ]);

    t.emit("change", LOG);
    await t.settle();
    expect(t.out.fired).toHaveLength(1);
  });
});
