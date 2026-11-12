import type { OAuthTokens, TokenStore } from "./oauth-types.js";

export interface SignOutOptions {
  /** Optional server-side revocation; endpoint specific, so injected. */
  revoke?: (tokens: OAuthTokens) => Promise<void>;
}

export interface SignOutResult {
  hadTokens: boolean;
  revoked: boolean;
}

/**
 * Deletes the stored tokens. Revocation is best effort: a failed or
 * offline revoke never keeps tokens on disk.
 */
export async function signOut(
  store: TokenStore,
  options: SignOutOptions = {},
): Promise<SignOutResult> {
  let tokens: OAuthTokens | null = null;
  try {
    tokens = await store.load();
  } catch {
    tokens = null;
  }
  let revoked = false;
  if (tokens && options.revoke) {
    try {
      await options.revoke(tokens);
      revoked = true;
    } catch {
      revoked = false;
    }
  }
  await store.clear();
  return { hadTokens: tokens !== null, revoked };
}
