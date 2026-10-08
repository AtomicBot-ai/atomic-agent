import { AsyncLocalStorage } from "node:async_hooks";

/** Serialize owned daemon work, replacing waiting choices with the latest.
 * Nested start/stop calls belong to their outer operation; they must neither
 * enqueue behind themselves nor invalidate the user's newer request. */
export class ModelOperationQueue {
  private readonly scope = new AsyncLocalStorage<{ signal: AbortSignal; active: boolean }>();
  private tail: Promise<void> = Promise.resolve();
  private latest: AbortController | null = null;
  private readonly controllers = new Set<AbortController>();
  private pending = 0;
  private blocking = 0;
  private closed = false;
  private version = 0;
  get revision(): number { return this.version; }

  get busy(): boolean { return this.pending > 0; }
  get switching(): boolean { return this.blocking > 0; }
  get signal(): AbortSignal | undefined { return this.scope.getStore()?.signal; }

  run<T>(body: (signal: AbortSignal) => Promise<T>, superseded: T, replace = true, blocking = true): Promise<T> {
    const parent = this.scope.getStore();
    if (parent?.active) return parent.signal.aborted ? Promise.resolve(superseded) : body(parent.signal);
    if (this.closed) return Promise.resolve(superseded);
    this.version++;
    if (replace) this.latest?.abort();
    const controller = new AbortController();
    if (replace) this.latest = controller;
    this.controllers.add(controller);
    this.pending++;
    if (blocking) this.blocking++;
    const task = this.tail.then(async () => {
      if (controller.signal.aborted) return superseded;
      const scope = { signal: controller.signal, active: true };
      try {
        const result = await this.scope.run(scope, () => body(controller.signal));
        return controller.signal.aborted ? superseded : result;
      } catch (error) {
        if (controller.signal.aborted) return superseded;
        throw error;
      } finally {
        scope.active = false;
      }
    }).finally(() => {
      this.pending--;
      if (blocking) this.blocking--;
      this.controllers.delete(controller);
      if (this.latest === controller) this.latest = null;
    });
    this.tail = task.then(() => {}, () => {});
    return task;
  }

  /** Background maintenance starts only if no newer user intent arrived. */
  defer(body: (signal: AbortSignal) => Promise<boolean>): void {
    const revision = this.version;
    void this.tail.then(() => {
      if (this.closed || this.busy || revision !== this.version) return;
      return this.scope.exit(() => this.run(body, false, true, false));
    }).catch(() => {});
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    await this.tail;
  }
}
