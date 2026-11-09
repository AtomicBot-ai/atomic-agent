import { describe, expect, it } from "vitest";

import { isAnalyticsKilledByEnv, isDoNotTrackSet } from "./read-analytics-kill-switch.js";

describe("isAnalyticsKilledByEnv", () => {
  it("is off by default", () => {
    expect(isAnalyticsKilledByEnv({})).toBe(false);
  });

  it("honours ATOMIC_AGENT_ANALYTICS=off and its synonyms", () => {
    for (const v of ["off", "0", "false", "no", "disabled", " OFF "]) {
      expect(isAnalyticsKilledByEnv({ ATOMIC_AGENT_ANALYTICS: v }), v).toBe(true);
    }
    expect(isAnalyticsKilledByEnv({ ATOMIC_AGENT_ANALYTICS: "on" })).toBe(false);
  });

  // ATO-1189: the cross-tool DO_NOT_TRACK convention turns both off too.
  it("honours DO_NOT_TRACK=1 and true", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on", " 1 "]) {
      expect(isAnalyticsKilledByEnv({ DO_NOT_TRACK: v }), v).toBe(true);
    }
  });

  it("ignores DO_NOT_TRACK=0, false or empty", () => {
    for (const v of ["0", "false", "", "no"]) {
      expect(isAnalyticsKilledByEnv({ DO_NOT_TRACK: v }), JSON.stringify(v)).toBe(false);
    }
  });

  it("DO_NOT_TRACK wins over ATOMIC_AGENT_ANALYTICS=on", () => {
    expect(isAnalyticsKilledByEnv({ DO_NOT_TRACK: "1", ATOMIC_AGENT_ANALYTICS: "on" })).toBe(true);
  });
});

describe("isDoNotTrackSet", () => {
  it("reads only DO_NOT_TRACK", () => {
    expect(isDoNotTrackSet({ DO_NOT_TRACK: "1" })).toBe(true);
    expect(isDoNotTrackSet({ ATOMIC_AGENT_ANALYTICS: "off" })).toBe(false);
  });
});
