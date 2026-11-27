import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FILE_CHANGED_DEPTH, FileChangedWatchers, isBroadFolder, type DirWatcherFactory, type FileChangeEvent } from "./file-changed-watcher.js";

/** A clock the test drives by hand. */
function manualClock() {
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  return {
    setTimeout: (fn: () => void, ms: number) => {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id: unknown) => { timers.delete(id as number); },
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) { timers.delete(id); t.fn(); }
      }
    },
  };
}

/** A watcher factory that records each watched folder and lets the test emit events. */
function fakeFactory() {
  const started: { root: string; depth: number; ignored: (p: string) => boolean; emit: (e: FileChangeEvent, p: string) => void; closed: boolean }[] = [];
  const factory: DirWatcherFactory = (root, options, listeners) => {
    const entry = { root, depth: options.depth, ignored: options.ignored, emit: listeners.onEvent, closed: false };
    started.push(entry);
    return { close: () => { entry.closed = true; } };
  };
  return { factory, started };
}

const project = resolve("/work/project");

describe("FileChanged watchers", () => {
  it("reports a burst of events on one path once, after the debounce, with the last event", () => {
    const clock = manualClock();
    const { factory, started } = fakeFactory();
    const onChange = vi.fn();
    const watchers = new FileChangedWatchers({ onChange, factory, clock, debounceMs: 300 });
    watchers.watch(project, "s1");
    const file = join(project, ".env");
    started[0]!.emit("add", file);
    clock.advance(100);
    started[0]!.emit("change", file);
    clock.advance(299);
    expect(onChange).not.toHaveBeenCalled();
    clock.advance(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(project, file, "change");
  });

  it("shares one watcher per folder and closes it when its last session leaves", () => {
    const { factory, started } = fakeFactory();
    const watchers = new FileChangedWatchers({ onChange: vi.fn(), factory, clock: manualClock() });
    watchers.watch(project, "s1");
    watchers.watch(project, "s2");
    expect(started).toHaveLength(1);
    expect(watchers.sessionFor(project)).toBe("s2");
    watchers.unwatch("s1");
    expect(started[0]!.closed).toBe(false);
    watchers.unwatch("s2");
    expect(started[0]!.closed).toBe(true);
    expect(watchers.watchedDirs()).toEqual([]);
  });

  it("a change pending when the folder closes is never reported", () => {
    const clock = manualClock();
    const { factory, started } = fakeFactory();
    const onChange = vi.fn();
    const watchers = new FileChangedWatchers({ onChange, factory, clock });
    watchers.watch(project, "s1");
    started[0]!.emit("change", join(project, "a.ts"));
    watchers.unwatch("s1");
    clock.advance(10_000);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("skips dependency and VCS folders, and watches only the top level of the home folder", () => {
    const { factory, started } = fakeFactory();
    const watchers = new FileChangedWatchers({ onChange: vi.fn(), factory, clock: manualClock() });
    watchers.watch(project, "s1");
    expect(started[0]!.depth).toBe(FILE_CHANGED_DEPTH);
    expect(started[0]!.ignored(join(project, "node_modules"))).toBe(true);
    expect(started[0]!.ignored(join(project, ".git"))).toBe(true);
    expect(started[0]!.ignored(join(project, "src"))).toBe(false);
    expect(started[0]!.ignored(project)).toBe(false);
    watchers.watch(homedir(), "s2");
    expect(started[1]!.depth).toBe(0);
    expect(isBroadFolder(resolve("/"))).toBe(true);
    expect(isBroadFolder(project)).toBe(false);
  });
});
