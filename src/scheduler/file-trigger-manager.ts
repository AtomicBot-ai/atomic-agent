import type { FileTriggerConfig } from "../config/file-trigger-config.js";
import type { StructuredLogger } from "../tracing/structured-logger.js";
import type { FileTriggerClaims } from "./file-trigger-claims.js";
import { resolveTriggerRoot } from "./file-trigger-guard.js";
import {
  FileTriggerWatcher,
  type FileTriggerClock,
  type FileTriggerFire,
  type FileTriggerFs,
  type FileWatcherFactory,
} from "./file-trigger-watcher.js";

/**
 * The set of file triggers this process runs (ATO-441). Watchers run
 * only while this process leads the scheduler (`setLeader`), so two
 * processes sharing one state dir never both file a task for the same
 * file; leadership loss and shutdown close every watcher.
 *
 * A former leader closes its watchers only on its next scheduler tick,
 * so right after a hand-over both processes watch for a moment
 * (ATO-2508). Each hit therefore asks `confirmLeader` (the lock, read
 * again now) and then takes a shared `claims` record before it files:
 * the former leader drops the hit and stands by, and if both still
 * pass, only one wins the claim.
 *
 * `reload` swaps the definitions: removed or changed entries stop, new
 * or changed ones start (if leading). Bootstrap wires the definitions
 * read at startup, so an edit to `fileTriggers` in config.json takes
 * effect on restart, like `webhooks`.
 */
export const MAX_FILE_TRIGGER_WATCHERS = 16;

export interface FileTriggerManagerOptions {
  definitions: Record<string, FileTriggerConfig>;
  factory: FileWatcherFactory;
  fs: FileTriggerFs;
  clock: FileTriggerClock;
  homeDir: string;
  /** Files the task; must not throw (log and drop instead). */
  fire(task: FileTriggerFire): void;
  /** Whether this process still leads, asked right before each hit files. */
  confirmLeader?: () => boolean;
  /** Cross-process run record per hit (see `file-trigger-claims.ts`). */
  claims?: FileTriggerClaims;
  logger?: StructuredLogger;
  maxWatchers?: number;
}

export class FileTriggerManager {
  private definitions: Record<string, FileTriggerConfig>;
  private readonly watchers = new Map<string, { watcher: FileTriggerWatcher; key: string }>();
  private leading = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly options: FileTriggerManagerOptions) {
    this.definitions = { ...options.definitions };
  }

  /** Names of the watchers running now. */
  activeNames(): string[] {
    return [...this.watchers.entries()]
      .filter(([, entry]) => !entry.watcher.isStopped)
      .map(([name]) => name);
  }

  /** The running watcher for `name`, for tests and diagnostics. */
  watcher(name: string): FileTriggerWatcher | undefined {
    return this.watchers.get(name)?.watcher;
  }

  setLeader(leading: boolean): Promise<void> {
    return this.serialize(async () => {
      if (leading === this.leading) return;
      this.leading = leading;
      if (leading) await this.sync();
      else await this.stopAll();
    });
  }

  reload(definitions: Record<string, FileTriggerConfig>): Promise<void> {
    return this.serialize(async () => {
      this.definitions = { ...definitions };
      if (this.leading) await this.sync();
    });
  }

  stop(): Promise<void> {
    return this.setLeader(false);
  }

  private serialize(job: () => Promise<void>): Promise<void> {
    const next = this.chain.then(job);
    this.chain = next.catch((err: unknown) => {
      this.options.logger?.warn("file triggers: update failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return this.chain;
  }

  private async stopAll(): Promise<void> {
    const running = [...this.watchers.values()];
    this.watchers.clear();
    await Promise.all(running.map(({ watcher }) => watcher.stop()));
  }

  private async sync(): Promise<void> {
    const wanted = new Map<string, string>();
    for (const [name, cfg] of Object.entries(this.definitions)) {
      if (cfg.enabled) wanted.set(name, JSON.stringify(cfg));
    }
    for (const [name, entry] of [...this.watchers.entries()]) {
      if (wanted.get(name) !== entry.key) {
        this.watchers.delete(name);
        await entry.watcher.stop();
      }
    }
    const max = this.options.maxWatchers ?? MAX_FILE_TRIGGER_WATCHERS;
    for (const [name, key] of wanted) {
      if (this.watchers.has(name)) continue;
      if (this.watchers.size >= max) {
        this.options.logger?.warn("file trigger not started: too many file triggers", {
          trigger: name,
          max,
        });
        continue;
      }
      const cfg = this.definitions[name];
      if (cfg === undefined) continue;
      const watcher = await this.create(name, cfg);
      if (watcher) this.watchers.set(name, { watcher, key });
    }
  }

  private async create(name: string, cfg: FileTriggerConfig): Promise<FileTriggerWatcher | null> {
    const root = resolveTriggerRoot(cfg.path, this.options.homeDir);
    if (!root.ok) {
      this.options.logger?.warn("file trigger refused", { trigger: name, path: cfg.path, reason: root.reason });
      return null;
    }
    const st = await this.options.fs.stat(root.path);
    if (!st) {
      this.options.logger?.warn("file trigger not started: path does not exist", {
        trigger: name,
        path: root.path,
      });
      return null;
    }
    const watcher = new FileTriggerWatcher({
      name,
      config: cfg,
      root: root.path,
      rootIsFile: st.isFile,
      factory: this.options.factory,
      fs: this.options.fs,
      clock: this.options.clock,
      fire: (task, claimKey) => this.fireIfOwner(task, claimKey),
      ...(this.options.logger ? { logger: this.options.logger } : {}),
    });
    watcher.start();
    this.options.logger?.info("file trigger watching", { trigger: name, path: root.path });
    return watcher;
  }

  private fireIfOwner(task: FileTriggerFire, claimKey: string): void {
    if (!this.leading) return;
    if (this.options.confirmLeader && !this.options.confirmLeader()) {
      this.options.logger?.info("file trigger hit left to the leading process", { trigger: task.trigger });
      return;
    }
    if (this.options.claims && !this.options.claims.claim(claimKey)) {
      this.options.logger?.info("file trigger hit already filed by another process", { trigger: task.trigger });
      return;
    }
    this.options.fire(task);
  }
}
