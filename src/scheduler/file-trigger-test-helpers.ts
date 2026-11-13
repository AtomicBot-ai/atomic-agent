import type { FileTriggerConfig } from "../config/file-trigger-config.js";
import type {
  FileTriggerClock,
  FileTriggerFire,
  FileTriggerFs,
  FileTriggerStat,
  FileWatcherFactory,
  FileWatchListeners,
  FileWatchOptions,
} from "./file-trigger-watcher.js";

/**
 * Hand-driven seams for the file trigger tests (ATO-441): a fake
 * watcher whose events the test emits, an in-memory filesystem and a
 * clock whose timers run only when the test says so. No real disk, no
 * real time, no sleeps.
 */

export interface FakeWatch {
  root: string;
  options: FileWatchOptions;
  listeners: FileWatchListeners;
  closed: boolean;
}

export function fakeWatcherFactory(): { factory: FileWatcherFactory; watches: FakeWatch[] } {
  const watches: FakeWatch[] = [];
  const factory: FileWatcherFactory = (root, options, listeners) => {
    const watch: FakeWatch = { root, options, listeners, closed: false };
    watches.push(watch);
    return {
      close: async () => {
        watch.closed = true;
      },
    };
  };
  return { factory, watches };
}

export function memoryFs(): {
  fs: FileTriggerFs;
  files: Map<string, { text: string; mtimeMs: number }>;
  dirs: Set<string>;
  write(path: string, text: string, mtimeMs?: number): void;
  append(path: string, text: string): void;
} {
  const files = new Map<string, { text: string; mtimeMs: number }>();
  const dirs = new Set<string>();
  let tick = 1;
  const fs: FileTriggerFs = {
    async stat(path): Promise<FileTriggerStat | null> {
      const file = files.get(path);
      if (file) return { size: Buffer.byteLength(file.text, "utf8"), mtimeMs: file.mtimeMs, isFile: true };
      if (dirs.has(path)) return { size: 0, mtimeMs: 0, isFile: false };
      return null;
    },
    async readRange(path, start, end) {
      return Buffer.from(files.get(path)?.text ?? "", "utf8").subarray(start, end);
    },
  };
  return {
    fs,
    files,
    dirs,
    write(path, text, mtimeMs) {
      files.set(path, { text, mtimeMs: mtimeMs ?? tick++ });
    },
    append(path, text) {
      const file = files.get(path);
      files.set(path, { text: (file?.text ?? "") + text, mtimeMs: tick++ });
    },
  };
}

export function manualClock(): {
  clock: FileTriggerClock;
  pending(): number;
  /** Run every timer that is due now (all of them: time is not modelled). */
  flush(): void;
  delays: number[];
} {
  const timers = new Map<number, () => void>();
  const delays: number[] = [];
  let next = 1;
  return {
    clock: {
      setTimeout(handler, ms) {
        const id = next++;
        timers.set(id, handler);
        delays.push(ms);
        return id;
      },
      clearTimeout(handle) {
        timers.delete(handle as number);
      },
    },
    pending: () => timers.size,
    flush() {
      const due = [...timers.entries()];
      timers.clear();
      for (const [, handler] of due) handler();
    },
    delays,
  };
}

export function recorder(): { fire(task: FileTriggerFire): void; fired: FileTriggerFire[] } {
  const fired: FileTriggerFire[] = [];
  return { fire: (task) => fired.push(task), fired };
}

export function triggerConfig(overrides: Partial<FileTriggerConfig> = {}): FileTriggerConfig {
  return {
    path: "/data/inbox",
    events: ["add"],
    debounceMs: 250,
    userMessageTemplate: "{{event}} {{relativePath}}",
    depth: 2,
    maxFiles: 100,
    enabled: true,
    ...overrides,
  };
}
