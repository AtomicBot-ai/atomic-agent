import { describe, expect, it, vi } from "vitest";

import { signOut } from "./logout.js";
import type { OAuthTokens, TokenStore } from "./oauth-types.js";

function store(initial: OAuthTokens | null) {
  let current = initial;
  const clear = vi.fn(async () => { current = null; });
  const s: TokenStore = { load: async () => current, save: async (t) => { current = t; }, clear };
  return { s, clear, get: () => current };
}

describe("signOut", () => {
  it("revokes and deletes the stored tokens", async () => {
    const { s, get } = store({ accessToken: "a", refreshToken: "r" });
    const revoke = vi.fn(async () => undefined);
    await expect(signOut(s, { revoke })).resolves.toEqual({ hadTokens: true, revoked: true });
    expect(revoke).toHaveBeenCalledWith({ accessToken: "a", refreshToken: "r" });
    expect(get()).toBeNull();
  });

  it("still deletes tokens when revocation fails", async () => {
    const { s, get } = store({ accessToken: "a" });
    const result = await signOut(s, { revoke: async () => { throw new Error("offline"); } });
    expect(result).toEqual({ hadTokens: true, revoked: false });
    expect(get()).toBeNull();
  });

  it("is a no-op that still clears when signed out", async () => {
    const { s, clear } = store(null);
    await expect(signOut(s)).resolves.toEqual({ hadTokens: false, revoked: false });
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
