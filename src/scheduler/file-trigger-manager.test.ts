import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import type { FileTriggerConfig } from "../config/file-trigger-config.js";
import { StructuredLogger, type LogRecord } from "../tracing/structured-logger.js";
import { FileTriggerManager } from "./file-trigger-manager.js";
import {
  fakeWatcherFactory,
  manualClock,
  memoryFs,
  recorder,
  triggerConfig,
} from "./file-trigger-test-helpers.js";

const HOME = resolve("/home/user");
const INBOX = join(HOME, "Inbox");
const LOGS = join(HOME, "logs");

function setup(definitions: Record<string, FileTriggerConfig>, maxWatchers?: number) {
  const { factory, watches } = fakeWatcherFactory();
  const disk = memoryFs();
  disk.dirs.add(INBOX);
  disk.dirs.add(LOGS);
  const time = manualClock();
  const out = recorder();
  const records: LogRecord[] = [];
  const manager = new FileTriggerManager({
    definitions,
    factory,
    fs: disk.fs,
    clock: time.clock,
    homeDir: HOME,
    fire: out.fire,
    logger: new StructuredLogger({ level: "debug", sinks: [(r) => records.push(r)] }),
    ...(maxWatchers !== undefined ? { maxWatchers } : {}),
  });
  const warnings = () => records.filter((r) => r.level === "warn").map((r) => r.message);
  return { manager, watches, disk, time, out, records, warnings };
}

describe("FileTriggerManager", () => {
  it("watches nothing until this process leads, and closes everything when it stops leading", async () => {
    const t = setup({ inbox: triggerConfig({ path: "~/Inbox" }) });
    expect(t.watches).toEqual([]);
    await t.manager.setLeader(true);
    expect(t.watches.map((w) => w.root)).toEqual([INBOX]);
    expect(t.manager.activeNames()).toEqual(["inbox"]);
    await t.manager.setLeader(true);
    expect(t.watches).toHaveLength(1);
    await t.manager.setLeader(false);
    expect(t.watches[0]?.closed).toBe(true);
    expect(t.manager.activeNames()).toEqual([]);
  });

  it("files a task for a new file through the fire callback", async () => {
    const t = setup({ inbox: triggerConfig({ path: "~/Inbox", userMessageTemplate: "Process {{path}}" }) });
    await t.manager.setLeader(true);
    const watch = t.watches[0]!;
    watch.listeners.onReady();
    const pdf = join(INBOX, "scan.pdf");
    t.disk.write(pdf, "%PDF");
    watch.listeners.onEvent("add", pdf);
    t.time.flush();
    await t.manager.watcher("inbox")!.whenIdle();
    expect(t.out.fired).toEqual([{ trigger: "inbox", userMessage: `Process ${pdf}` }]);
  });

  it("refuses the home directory, a root and missing paths, with a diagnostic each", async () => {
    const t = setup({
      home: triggerConfig({ path: "~" }),
      root: triggerConfig({ path: resolve("/") }),
      missing: triggerConfig({ path: "~/Nope" }),
      inbox: triggerConfig({ path: "~/Inbox" }),
    });
    await t.manager.setLeader(true);
    expect(t.manager.activeNames()).toEqual(["inbox"]);
    expect(t.warnings()).toEqual([
      "file trigger refused",
      "file trigger refused",
      "file trigger not started: path does not exist",
    ]);
  });

  it("skips disabled entries and caps the number of watchers", async () => {
    const t = setup(
      {
        off: triggerConfig({ path: "~/Inbox", enabled: false }),
        one: triggerConfig({ path: "~/Inbox" }),
        two: triggerConfig({ path: "~/logs" }),
        three: triggerConfig({ path: "~/Inbox", glob: "*.txt" }),
      },
      2,
    );
    await t.manager.setLeader(true);
    expect(t.manager.activeNames()).toEqual(["one", "two"]);
    expect(t.warnings()).toEqual(["file trigger not started: too many file triggers"]);
  });

  it("reload restarts changed entries, stops removed ones and keeps the rest", async () => {
    const inbox = triggerConfig({ path: "~/Inbox" });
    const logs = triggerConfig({ path: "~/logs", events: ["change"], contains: "ERROR" });
    const t = setup({ inbox, logs });
    await t.manager.setLeader(true);
    const [inboxWatch, logsWatch] = t.watches;
    await t.manager.reload({ inbox: { ...inbox, glob: "*.pdf" }, fresh: triggerConfig({ path: "~/logs" }) });
    expect(inboxWatch?.closed).toBe(true);
    expect(logsWatch?.closed).toBe(true);
    expect(t.manager.activeNames().sort()).toEqual(["fresh", "inbox"]);
    expect(t.watches).toHaveLength(4);
    await t.manager.reload({ inbox: { ...inbox, glob: "*.pdf" }, fresh: triggerConfig({ path: "~/logs" }) });
    expect(t.watches).toHaveLength(4);
  });

  it("reload while standing by only remembers the definitions", async () => {
    const t = setup({});
    await t.manager.reload({ inbox: triggerConfig({ path: "~/Inbox" }) });
    expect(t.watches).toEqual([]);
    await t.manager.setLeader(true);
    expect(t.manager.activeNames()).toEqual(["inbox"]);
    await t.manager.stop();
    expect(t.watches[0]?.closed).toBe(true);
  });

  it("a watcher that stopped itself is not counted as active", async () => {
    const t = setup({ inbox: triggerConfig({ path: "~/Inbox", maxFiles: 1 }) });
    await t.manager.setLeader(true);
    const watch = t.watches[0]!;
    watch.listeners.onEvent("add", join(INBOX, "a"));
    watch.listeners.onEvent("add", join(INBOX, "b"));
    expect(t.manager.activeNames()).toEqual([]);
    expect(t.warnings()).toContain("file trigger stopped");
  });
});
