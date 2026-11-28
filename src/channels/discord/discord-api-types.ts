/**
 * The shapes and the error the Discord REST client (`discord-api.ts`)
 * hands its callers. Re-exported from there.
 */

export interface DiscordUser {
  id: string;
  username: string;
  discriminator?: string;
}

export class DiscordApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "DiscordApiError";
    this.status = status;
  }
}

/** One outbound message component row (approval buttons). */
export interface DiscordComponentRow {
  type: 1;
  components: ReadonlyArray<{
    type: 2;
    style: number;
    label: string;
    custom_id: string;
  }>;
}

export interface DiscordApiOptions {
  token: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Test seam; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}
