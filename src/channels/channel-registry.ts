/**
 * Owns every chat channel the runtime built, behind the shared
 * `Channel` surface (ATO-1169).
 *
 * Telegram and Discord are registered here too, so hosts can list and
 * stop channels without naming each one; they keep their own typed
 * handles on the runtime (`telegramChannel`, `discordChannel`) because
 * their hosts call adapter-specific methods (pairing, owner ids).
 * Adapters from `channel-catalog.ts` are only reachable through here.
 */

import type { StructuredLogger } from "../tracing/structured-logger.js";
import type { Channel } from "./channel.js";

export class ChannelRegistry {
  private readonly channels = new Map<string, Channel>();

  constructor(private readonly logger: StructuredLogger) {}

  /** Add a channel. A second channel with the same id is a wiring bug. */
  register(channel: Channel): void {
    if (this.channels.has(channel.id)) {
      throw new Error(`channel "${channel.id}" is already registered`);
    }
    this.channels.set(channel.id, channel);
  }

  get(id: string): Channel | null {
    return this.channels.get(id) ?? null;
  }

  /** Every registered channel, in registration order. */
  list(): readonly Channel[] {
    return [...this.channels.values()];
  }

  /**
   * Start `ids` fire-and-forget, like the primaries at boot: a slow
   * connect never delays the first turn, and a rejected `start()` is
   * logged rather than thrown into bootstrap.
   */
  startInBackground(ids: readonly string[]): void {
    for (const id of ids) {
      const channel = this.channels.get(id);
      if (!channel) continue;
      void channel.start().catch((err) => {
        this.logger.error(`${id}: start() rejected unexpectedly`, {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  /**
   * Stop every channel except `skip` (the ones shutdown already stops
   * in its own order). One channel failing to stop never keeps the
   * others connected.
   */
  async stopAll(skip: ReadonlySet<string> = new Set()): Promise<void> {
    await Promise.all(
      this.list()
        .filter((channel) => !skip.has(channel.id))
        .map(async (channel) => {
          try {
            await channel.stop();
          } catch (err) {
            this.logger.warn(`${channel.id}: shutdown failed`, {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }),
    );
  }
}
