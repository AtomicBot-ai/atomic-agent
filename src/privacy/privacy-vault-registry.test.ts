import { afterEach, describe, expect, it } from "vitest";

import {
  forgetPrivacyVault,
  isPrivacyShieldEnabled,
  privacyShieldTotals,
  privacyVaultFor,
  resetPrivacyVaults,
  setPrivacyKnownSecrets,
  setPrivacyShieldEnabled,
} from "./privacy-vault-registry.js";

afterEach(() => resetPrivacyVaults());

describe("privacy vault registry (ATO-599)", () => {
  it("keeps one vault per session, and one shared vault without an id", () => {
    expect(privacyVaultFor("s1")).toBe(privacyVaultFor("s1"));
    expect(privacyVaultFor("s1")).not.toBe(privacyVaultFor("s2"));
    expect(privacyVaultFor(undefined)).toBe(privacyVaultFor(""));
  });

  it("numbers placeholders per session", () => {
    expect(privacyVaultFor("s1").mask("a@b.io")).toBe("[EMAIL_1]");
    expect(privacyVaultFor("s2").mask("c@d.io")).toBe("[EMAIL_1]");
    expect(privacyVaultFor("s2").unmask("[EMAIL_1]")).toBe("c@d.io");
  });

  it("sums the masked-N totals and forgets a deleted session", () => {
    privacyVaultFor("s1").mask("a@b.io c@d.io");
    privacyVaultFor("s2").mask("e@f.io");
    privacyVaultFor("s3").mask("nothing");
    expect(privacyShieldTotals()).toEqual({ masked: 3, sessions: 2 });
    forgetPrivacyVault("s1");
    expect(privacyShieldTotals()).toEqual({ masked: 1, sessions: 1 });
  });

  it("passes the agent's known keys to new vaults", () => {
    setPrivacyKnownSecrets(() => [{ label: "MY_KEY", value: "Zq8vLp3mWx7tRb2n" }]);
    expect(privacyVaultFor("s1").mask("key Zq8vLp3mWx7tRb2n")).toBe("key [SECRET_1]");
  });

  it("is off until switched on", () => {
    expect(isPrivacyShieldEnabled()).toBe(false);
    setPrivacyShieldEnabled(true);
    expect(isPrivacyShieldEnabled()).toBe(true);
  });
});
