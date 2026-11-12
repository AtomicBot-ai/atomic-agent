/**
 * Bounded memory of message ids already turned into tasks, so a
 * Standard Webhooks message that arrives twice (a sender retry, or a
 * captured request replayed inside the timestamp window) starts at most
 * one task. Insertion-ordered `Map`: when full, the oldest id goes. It is
 * per process on purpose: the timestamp window already bounds how long
 * a replay can be useful, and a restart only reopens that short window.
 */
export const DEFAULT_REPLAY_CACHE_SIZE = 1000;

export class WebhookReplayCache {
  private readonly seen = new Map<string, true>();

  constructor(private readonly capacity: number = DEFAULT_REPLAY_CACHE_SIZE) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`replay cache capacity must be a positive integer, got ${capacity}`);
    }
  }

  has(key: string): boolean {
    return this.seen.has(key);
  }

  remember(key: string): void {
    this.seen.delete(key);
    this.seen.set(key, true);
    while (this.seen.size > this.capacity) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }

  get size(): number {
    return this.seen.size;
  }
}
