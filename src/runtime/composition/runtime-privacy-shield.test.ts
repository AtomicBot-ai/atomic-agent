import { afterEach, describe, expect, it } from "vitest";

import { isPrivacyShieldEnabled, privacyVaultFor, resetPrivacyVaults } from "../../privacy/index.js";
import { createPrivacyShieldControl } from "./runtime-privacy-shield.js";

afterEach(() => resetPrivacyVaults());

describe("runtime.privacyShield (ATO-1082)", () => {
  it("persists and applies the switch", async () => {
    const written: boolean[] = [];
    const control = createPrivacyShieldControl({ persist: (on) => written.push(on) });
    expect(control.isEnabled()).toBe(false);
    await control.setEnabled(true);
    expect(written).toEqual([true]);
    expect(isPrivacyShieldEnabled()).toBe(true);
    expect(control.isEnabled()).toBe(true);
    await control.setEnabled(false);
    expect(isPrivacyShieldEnabled()).toBe(false);
  });

  it("reports masked counts for the process and one chat", () => {
    const control = createPrivacyShieldControl({ persist: () => {} });
    const vault = privacyVaultFor("s1");
    vault.beginRequest();
    vault.mask("a@b.io and 4111111111111111");
    vault.endRequest();
    privacyVaultFor("s2").mask("c@d.io");
    expect(control.stats()).toEqual({ masked: 3, sessions: 2 });
    expect(control.stats("s1")).toEqual({
      masked: 3,
      sessions: 2,
      session: { masked: 2, lastRequest: 2 },
    });
  });
});
