import { open, stat } from "node:fs/promises";
import { watch } from "chokidar";
import type {
  FileTriggerClock,
  FileTriggerFs,
  FileWatcherFactory,
} from "./file-trigger-watcher.js";

/**
 * Production seams for file triggers (ATO-441): chokidar for events,
 * `node:fs` for stats and appended bytes, real timers for the debounce.
 * Kept out of the watcher so its tests never touch the disk or the clock.
 */
export const chokidarWatcherFactory: FileWatcherFactory = (root, options, listeners) => {
  const watcher = watch(root, {
    persistent: true,
    // The initial scan is how the watcher counts files (maxFiles) and
    // learns log sizes; it never fires a task (see FileTriggerWatcher).
    ignoreInitial: false,
    depth: options.depth,
    followSymlinks: false,
    ignored: (path, stats) =>
      options.ignored(path, stats === undefined ? undefined : stats.isDirectory()),
  });
  watcher.on("add", (path) => listeners.onEvent("add", path));
  watcher.on("change", (path) => listeners.onEvent("change", path));
  watcher.on("unlink", (path) => listeners.onEvent("unlink", path));
  watcher.on("ready", () => listeners.onReady());
  watcher.on("error", (err) =>
    listeners.onError(err instanceof Error ? err : new Error(String(err))),
  );
  return { close: () => watcher.close() };
};

export const nodeFileTriggerFs: FileTriggerFs = {
  async stat(path) {
    try {
      const st = await stat(path);
      return { size: st.size, mtimeMs: st.mtimeMs, isFile: st.isFile() };
    } catch {
      return null;
    }
  },
  async readRange(path, start, end) {
    const length = Math.max(0, end - start);
    const buffer = Buffer.alloc(length);
    const handle = await open(path, "r");
    try {
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  },
};

export const realFileTriggerClock: FileTriggerClock = {
  setTimeout: (handler, ms) => {
    const timer = setTimeout(handler, ms);
    // A pending debounce must not keep a stopping process alive.
    timer.unref?.();
    return timer;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};
