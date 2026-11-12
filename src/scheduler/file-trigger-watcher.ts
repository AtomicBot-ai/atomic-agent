import { basename, relative, sep } from "node:path";
import type { FileTriggerConfig } from "../config/file-trigger-config.js";
import type { StructuredLogger } from "../tracing/structured-logger.js";
import { isInIgnoredDir, matchesTriggerGlob } from "./file-trigger-guard.js";
import { LogTail, type FileTriggerReader } from "./file-trigger-tail.js";
import { renderFileTriggerTemplate } from "./file-trigger-template.js";

/**
 * One running file trigger (ATO-441): a filesystem watcher on one path,
 * a debounce per file, a dedupe of repeats and the cap on how many files
 * it may cover. Everything that touches the outside world is a seam, so
 * tests drive events, file stats and timers by hand.
 */

export type WatchEventKind = "add" | "change" | "unlink";

export interface FileWatchHandle {
  close(): Promise<void>;
}

export interface FileWatchListeners {
  onEvent(kind: WatchEventKind, path: string): void;
  /** The initial scan finished; later `add`s are new files. */
  onReady(): void;
  onError(err: Error): void;
}

export interface FileWatchOptions {
  depth: number;
  /** `isDir` is undefined when the watcher does not know yet. */
  ignored(path: string, isDir: boolean | undefined): boolean;
}

export type FileWatcherFactory = (
  root: string,
  options: FileWatchOptions,
  listeners: FileWatchListeners,
) => FileWatchHandle;

export interface FileTriggerStat {
  size: number;
  mtimeMs: number;
  isFile: boolean;
}

export interface FileTriggerFs extends FileTriggerReader {
  stat(path: string): Promise<FileTriggerStat | null>;
}

export interface FileTriggerClock {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface FileTriggerFire {
  trigger: string;
  userMessage: string;
  sessionId?: string;
}

export interface FileTriggerWatcherOptions {
  name: string;
  config: FileTriggerConfig;
  /** Resolved, guarded root (see `resolveTriggerRoot`). */
  root: string;
  /** The root is a single file rather than a folder. */
  rootIsFile: boolean;
  factory: FileWatcherFactory;
  fs: FileTriggerFs;
  clock: FileTriggerClock;
  fire(task: FileTriggerFire): void;
  logger?: StructuredLogger;
  /** Called once when the watcher stops itself (cap hit, watcher error). */
  onSelfStop?(name: string, reason: string): void;
}

/** How many `path|mtime|size` signatures one trigger remembers. */
const SEEN_LIMIT = 2_000;

export class FileTriggerWatcher {
  private handle: FileWatchHandle | null = null;
  private ready = false;
  private stopped = false;
  private readonly known = new Set<string>();
  private readonly pending = new Map<string, { kind: WatchEventKind; timer: unknown }>();
  private readonly seen = new Set<string>();
  private readonly tail: LogTail;
  private work: Promise<void> = Promise.resolve();

  constructor(private readonly options: FileTriggerWatcherOptions) {
    this.tail = new LogTail(options.fs);
  }

  get name(): string {
    return this.options.name;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  start(): void {
    if (this.handle || this.stopped) return;
    const { root, config } = this.options;
    this.handle = this.options.factory(
      root,
      {
        depth: this.options.rootIsFile ? 0 : config.depth,
        ignored: (path, isDir) => {
          if (isInIgnoredDir(root, path)) return true;
          if (this.options.rootIsFile || isDir !== false) return false;
          return !matchesTriggerGlob(root, path, config.glob);
        },
      },
      {
        onEvent: (kind, path) => this.onEvent(kind, path),
        onReady: () => {
          this.ready = true;
        },
        onError: (err) => this.stopSelf(`watcher error: ${err.message}`),
      },
    );
  }

  /** Settles once every file handled so far has been processed. */
  whenIdle(): Promise<void> {
    return this.work;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const { timer } of this.pending.values()) this.options.clock.clearTimeout(timer);
    this.pending.clear();
    const handle = this.handle;
    this.handle = null;
    if (handle) {
      try {
        await handle.close();
      } catch {
        // a watcher that fails to close has nothing left to tell us
      }
    }
  }

  private onEvent(kind: WatchEventKind, path: string): void {
    if (this.stopped) return;
    const { root, config, rootIsFile } = this.options;
    if (isInIgnoredDir(root, path)) return;
    if (!rootIsFile && !matchesTriggerGlob(root, path, config.glob)) return;
    if (kind === "unlink") {
      this.known.delete(path);
      this.tail.forget(path);
      const entry = this.pending.get(path);
      if (entry) this.options.clock.clearTimeout(entry.timer);
      this.pending.delete(path);
      return;
    }
    if (!this.known.has(path)) {
      this.known.add(path);
      if (this.known.size > config.maxFiles) {
        this.stopSelf(`more than ${config.maxFiles} files under the watched path (maxFiles)`);
        return;
      }
    }
    if (!this.ready) {
      // Initial scan: files already there never fire. A `contains`
      // trigger remembers their size, so only lines written later count.
      if (config.contains !== undefined) this.enqueueWork(() => this.seed(path));
      return;
    }
    if (!config.events.includes(kind as "add" | "change")) return;
    const previous = this.pending.get(path);
    if (previous) this.options.clock.clearTimeout(previous.timer);
    const merged: WatchEventKind = previous?.kind === "add" ? "add" : kind;
    const timer = this.options.clock.setTimeout(() => {
      this.pending.delete(path);
      this.enqueueWork(() => this.process(path, merged));
    }, config.debounceMs);
    this.pending.set(path, { kind: merged, timer });
  }

  private enqueueWork(job: () => Promise<void>): void {
    this.work = this.work.then(job).catch((err: unknown) => {
      this.options.logger?.warn("file trigger: handling a file failed", {
        trigger: this.options.name,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private async seed(path: string): Promise<void> {
    const st = await this.options.fs.stat(path);
    if (st?.isFile && !this.tail.has(path)) this.tail.seed(path, st.size);
  }

  private async process(path: string, kind: WatchEventKind): Promise<void> {
    if (this.stopped) return;
    const st = await this.options.fs.stat(path);
    if (!st || !st.isFile || this.stopped) return;
    const { config } = this.options;
    let lines: string[] = [];
    if (config.contains !== undefined) {
      lines = await this.tail.readNewMatches(path, st.size, config.contains);
      if (lines.length === 0) return;
    } else {
      const signature = `${path}|${st.mtimeMs}|${st.size}`;
      if (this.seen.has(signature)) return;
      this.seen.add(signature);
      if (this.seen.size > SEEN_LIMIT) {
        const oldest = this.seen.values().next().value;
        if (oldest !== undefined) this.seen.delete(oldest);
      }
    }
    if (this.stopped) return;
    const relativePath = this.options.rootIsFile
      ? basename(path)
      : relative(this.options.root, path).split(sep).join("/");
    this.options.fire({
      trigger: this.options.name,
      userMessage: renderFileTriggerTemplate(config.userMessageTemplate, {
        path,
        relativePath,
        name: basename(path),
        event: kind,
        trigger: this.options.name,
        lines: lines.join("\n"),
      }),
      ...(config.sessionId !== undefined ? { sessionId: config.sessionId } : {}),
    });
  }

  private stopSelf(reason: string): void {
    if (this.stopped) return;
    this.options.logger?.warn("file trigger stopped", {
      trigger: this.options.name,
      path: this.options.root,
      reason,
    });
    void this.stop();
    this.options.onSelfStop?.(this.options.name, reason);
  }
}
