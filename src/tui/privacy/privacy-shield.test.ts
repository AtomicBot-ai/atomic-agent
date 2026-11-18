import { describe, expect, it } from "vitest";

import {
  readPrivacyShieldControl,
  shieldCounterLine,
  snapshotPrivacyShield,
  type PrivacyShieldControl,
} from "./privacy-shield.js";

function control(over: Partial<PrivacyShieldControl> = {}): PrivacyShieldControl {
  return {
    isEnabled: () => true,
    setEnabled: async () => {},
    stats: (sessionId) => ({ masked: 7, sessions: 2, ...(sessionId ? { session: { masked: 3 } } : {}) }),
    ...over,
  };
}

describe("Privacy Shield in the Privacy tab (ATO-1082)", () => {
  it("reads the runtime's control structurally", () => {
    expect(readPrivacyShieldControl(null)).toBeNull();
    expect(readPrivacyShieldControl({})).toBeNull();
    expect(readPrivacyShieldControl({ privacyShield: { isEnabled: () => true } })).toBeNull();
    const c = control();
    expect(readPrivacyShieldControl({ privacyShield: c })).toBe(c);
  });

  it("snapshots on/off and the counters, never throwing", () => {
    expect(snapshotPrivacyShield(null)).toEqual({
      supported: false,
      enabled: false,
      masked: null,
      sessionMasked: null,
    });
    expect(snapshotPrivacyShield(control(), "s1")).toEqual({
      supported: true,
      enabled: true,
      masked: 7,
      sessionMasked: 3,
    });
    const broken = control({
      isEnabled: () => {
        throw new Error("x");
      },
      stats: () => {
        throw new Error("y");
      },
    });
    expect(snapshotPrivacyShield(broken)).toEqual({
      supported: true,
      enabled: false,
      masked: null,
      sessionMasked: null,
    });
  });

  it("words the counter line", () => {
    expect(shieldCounterLine(snapshotPrivacyShield(control(), "s1"))).toBe(
      "masked 3 values in this chat · 7 since the agent started",
    );
    expect(shieldCounterLine(snapshotPrivacyShield(control()))).toBe("masked 7 values since the agent started");
    expect(
      shieldCounterLine({ supported: true, enabled: true, masked: 1, sessionMasked: null }),
    ).toBe("masked 1 value since the agent started");
    expect(shieldCounterLine({ supported: true, enabled: true, masked: null, sessionMasked: null })).toBeNull();
  });
});
