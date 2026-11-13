/** Shared shapes for the OAuth primitives. Endpoints and ids are injected. */

/** Minimal `fetch` surface the primitives need; pass `globalThis.fetch`. */
export type FetchLike = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{
  status: number;
  ok: boolean;
  text(): Promise<string>;
}>;

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  tokenType?: string;
  scope?: string;
  /** Absolute expiry in epoch milliseconds, when the server reported one. */
  expiresAt?: number;
}

/**
 * Persistence seam. This module never stores tokens itself; the secure
 * store is owned by ATO-1120 and is passed in by the caller.
 */
export interface TokenStore {
  load(): Promise<OAuthTokens | null>;
  save(tokens: OAuthTokens): Promise<void>;
  clear(): Promise<void>;
}

export type Clock = () => number;

/** Abortable delay; injected in tests so polling runs without real waits. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;
