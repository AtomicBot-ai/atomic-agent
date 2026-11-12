import { describe, expect, it } from "vitest";

import {
  OFFLINE_PAUSED_DETAIL,
  offlineIntegrationStatus,
} from "./integration-offline-status.js";

describe("integration status while offline", () => {
  const up = { level: "connected" as const, detail: "channel up" };

  it("is unchanged while offline mode is off", () => {
    expect(offlineIntegrationStatus("telegram", up, false)).toBe(up);
  });

  it("pauses Telegram, Discord and Atomic Mail with one plain line", () => {
    for (const id of ["telegram", "discord", "atomic-mail"]) {
      expect(offlineIntegrationStatus(id, up, true)).toEqual({
        level: "configured",
        detail: OFFLINE_PAUSED_DETAIL,
      });
    }
    const failed = { level: "error" as const, detail: "channel failed to start" };
    expect(offlineIntegrationStatus("telegram", failed, true).detail).toBe(
      OFFLINE_PAUSED_DETAIL,
    );
  });

  it("keeps the setup hint for a channel that is not set up yet", () => {
    const fresh = { level: "not_configured" as const, detail: "no bot token" };
    expect(offlineIntegrationStatus("telegram", fresh, true)).toBe(fresh);
  });

  it("leaves integrations that are not channels alone", () => {
    expect(offlineIntegrationStatus("github", up, true)).toBe(up);
  });
});
