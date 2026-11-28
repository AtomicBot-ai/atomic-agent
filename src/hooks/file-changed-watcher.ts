import { homedir } from "node:os";
import { basename, parse, resolve } from "node:path";
import { watch } from "chokidar";

export type FileChangeEvent = "add" | "change" | "unlink";

export interface DirWatcher {
  close(): Promise<void> | void;
}

/** Starts watching `root` down to `depth` levels; `ignored` names are never entered. */
export type DirWatcherFactory = (
  root: string,
  options: { depth: number; ignored: (path: string) => boolean },
  listeners: { onEvent(event: FileChangeEvent, path: string): void; onError(err: Error): void },
) => DirWatcher;

export interface WatchClock {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface FileChangedWatchersOptions {
  /** One change, after the debounce: the folder it was seen in, the path and what happened. */
  onChange(dir: string, path: string, event: FileChangeEvent): void;
  onError?(dir: string, err: Error): void;
  /** Test seams. */
  factory?: DirWatcherFactory;
  clock?: WatchClock;
  debounceMs?: number;
}

/** Quiet time per path before a change is reported, as Qwen Code's FileChangedWatcher debounces. */
export const FILE_CHANGED_DEBOUNCE_MS = 300;
/** How deep a project folder is watched. */
export const FILE_CHANGED_DEPTH = 3;

/** Folders never watched: tool output, dependencies and VCS data change all the time. */
const IGNORED_NAMES = new Set([
  ".git", ".hg", ".svn", "node_modules", ".atomic-agent", "dist", "build", "out", ".next", ".nuxt",
  ".turbo", ".cache", "target", ".venv", "venv", "__pycache__", ".pytest_cache", ".gradle", ".idea",
  "Library", "AppData",
]);

/**
 * A folder too broad to watch deeply (the home folder or a drive root):
 * only its own top-level files are watched there, so a chat opened in `~`
 * does not walk the whole disk.
 */
export function isBroadFolder(dir: string): boolean {
  const abs = resolve(dir);
  return abs === resolve(homedir()) || abs === parse(abs).root;
}

const realClock: WatchClock = {
  setTimeout: (handler, ms) => {
    const timer = setTimeout(handler, ms);
    timer.unref?.();
    return timer;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export const chokidarDirWatcher: DirWatcherFactory = (root, options, listeners) => {
  const watcher = watch(root, {
    persistent: false,
    ignoreInitial: true,
    depth: options.depth,
    followSymlinks: false,
    ignored: (path) => options.ignored(path),
  });
  watcher.on("add", (path) => listeners.onEvent("add", path));
  watcher.on("change", (path) => listeners.onEvent("change", path));
  watcher.on("unlink", (path) => listeners.onEvent("unlink", path));
  watcher.on("error", (err) => listeners.onError(err instanceof Error ? err : new Error(String(err))));
  return { close: () => watcher.close() };
};

interface Watched {
  watcher: DirWatcher;
  sessions: Set<string>;
  timers: Map<string, { handle: unknown; event: FileChangeEvent }>;
}

/**
 * One watcher per working folder, shared by the sessions that use it, for
 * the FileChanged hooks (ATO-2462). A burst of events on one path is
 * reported once, after `debounceMs` of quiet, with the last event. The
 * watcher closes when its last session ends.
 */
export class FileChangedWatchers {
  private readonly dirs = new Map<string, Watched>();

  constructor(private readonly options: FileChangedWatchersOptions) {}

  /** Watch `dir` for `sessionId`; a folder already watched is shared. */
  watch(dir: string, sessionId: string): void {
    const root = resolve(dir);
    const existing = this.dirs.get(root);
    if (existing) {
      existing.sessions.add(sessionId);
      return;
    }
    const entry: Watched = { watcher: { close: () => undefined }, sessions: new Set([sessionId]), timers: new Map() };
    this.dirs.set(root, entry);
    const factory = this.options.factory ?? chokidarDirWatcher;
    try {
      entry.watcher = factory(
        root,
        { depth: isBroadFolder(root) ? 0 : FILE_CHANGED_DEPTH, ignored: (path) => path !== root && IGNORED_NAMES.has(basename(path)) },
        { onEvent: (event, path) => this.debounce(root, entry, event, path), onError: (err) => this.options.onError?.(root, err) },
      );
    } catch (err) {
      this.options.onError?.(root, err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** The folders `sessionId` watches lose it; a folder nobody uses any more is closed. */
  unwatch(sessionId: string): void {
    for (const [root, entry] of this.dirs) {
      if (!entry.sessions.delete(sessionId) || entry.sessions.size > 0) continue;
      this.close(root, entry);
    }
  }

  /** A session that watches `dir` (the latest one added), for the hook's `session_id`. */
  sessionFor(dir: string): string | undefined {
    const sessions = this.dirs.get(resolve(dir))?.sessions;
    return sessions ? [...sessions].at(-1) : undefined;
  }

  watchedDirs(): string[] {
    return [...this.dirs.keys()];
  }

  async closeAll(): Promise<void> {
    const closing = [...this.dirs].map(([root, entry]) => this.close(root, entry));
    await Promise.all(closing);
  }

  private debounce(root: string, entry: Watched, event: FileChangeEvent, path: string): void {
    const clock = this.options.clock ?? realClock;
    const pending = entry.timers.get(path);
    if (pending) clock.clearTimeout(pending.handle);
    const handle = clock.setTimeout(() => {
      entry.timers.delete(path);
      if (this.dirs.get(root) !== entry) return;
      this.options.onChange(root, path, event);
    }, this.options.debounceMs ?? FILE_CHANGED_DEBOUNCE_MS);
    entry.timers.set(path, { handle, event });
  }

  private async close(root: string, entry: Watched): Promise<void> {
    const clock = this.options.clock ?? realClock;
    for (const { handle } of entry.timers.values()) clock.clearTimeout(handle);
    entry.timers.clear();
    this.dirs.delete(root);
    try {
      await entry.watcher.close();
    } catch {
      // A watcher that fails to close is gone with the process anyway.
    }
  }
}
