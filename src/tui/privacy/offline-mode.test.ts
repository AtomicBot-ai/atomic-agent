import { describe, expect, it } from "vitest";

import {
  formatEgressBytes,
  normalizeEgress,
  offlineEgressLine,
  readOfflineModeControl,
  snapshotOfflineMode,
} from "./offline-mode.js";

const SINCE = "2026-11-12T10:00:00.000Z";
const egress = (over: Record<string, unknown> = {}) => ({
  bytesOut: 0,
  requestsOut: 0,
  requestsBlocked: 0,
  since: SINCE,
  ...over,
});

describe("readOfflineModeControl", () => {
  it("is null for a runtime without the kill switch", () => {
    expect(readOfflineModeControl(null)).toBeNull();
    expect(readOfflineModeControl({})).toBeNull();
    expect(readOfflineModeControl({ offlineMode: true })).toBeNull();
    // Half-shaped: missing egress() must not count as supported.
    expect(
      readOfflineModeControl({
        offlineMode: { isEnabled: () => false, setEnabled: async () => {} },
      }),
    ).toBeNull();
  });

  it("returns the control when it has all three methods", () => {
    const offlineMode = {
      isEnabled: () => true,
      setEnabled: async () => {},
      egress: () => egress(),
    };
    expect(readOfflineModeControl({ offlineMode })).toBe(offlineMode);
  });
});

describe("normalizeEgress", () => {
  it("keeps a well-formed counter", () => {
    expect(normalizeEgress(egress({ bytesOut: 12.7, requestsOut: 2 }))).toEqual(
      egress({ bytesOut: 12, requestsOut: 2 }),
    );
  });

  it("drops a counter with a missing or bad field instead of guessing", () => {
    expect(normalizeEgress(undefined)).toBeNull();
    expect(normalizeEgress(egress({ bytesOut: undefined }))).toBeNull();
    expect(normalizeEgress(egress({ bytesOut: -1 }))).toBeNull();
    expect(normalizeEgress(egress({ requestsBlocked: Number.NaN }))).toBeNull();
    expect(normalizeEgress(egress({ since: "not a time" }))).toBeNull();
  });
});

describe("snapshotOfflineMode", () => {
  it("is unsupported without a control", () => {
    expect(snapshotOfflineMode(null)).toEqual({
      supported: false,
      enabled: false,
      egress: null,
    });
  });

  it("survives a control that throws", () => {
    const snap = snapshotOfflineMode({
      isEnabled: () => {
        throw new Error("boom");
      },
      setEnabled: async () => {},
      egress: () => {
        throw new Error("boom");
      },
    });
    expect(snap).toEqual({ supported: true, enabled: false, egress: null });
  });
});

describe("offlineEgressLine", () => {
  it("prints the reported bytes and the blocked count", () => {
    const line = offlineEgressLine(egress({ requestsBlocked: 3 }));
    expect(line).toMatch(/^0 bytes sent out since \d\d:\d\d · 3 requests blocked$/);
    expect(offlineEgressLine(egress({ bytesOut: 1536, requestsBlocked: 1 }))).toMatch(
      /^1\.5 KB sent out since \d\d:\d\d · 1 request blocked$/,
    );
    expect(offlineEgressLine(egress({ bytesOut: 5 }))).not.toContain("blocked");
  });

  it("is null without a counter", () => {
    expect(offlineEgressLine(null)).toBeNull();
  });
});

describe("formatEgressBytes", () => {
  it("reads like a person would say it", () => {
    expect(formatEgressBytes(0)).toBe("0 bytes");
    expect(formatEgressBytes(1)).toBe("1 byte");
    expect(formatEgressBytes(1023)).toBe("1023 bytes");
    expect(formatEgressBytes(1024)).toBe("1 KB");
    expect(formatEgressBytes(15 * 1024 * 1024)).toBe("15 MB");
  });
});
