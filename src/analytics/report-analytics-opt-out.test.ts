import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { reportAnalyticsOptOut } from "./report-analytics-opt-out.js";

describe("reportAnalyticsOptOut", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-optout-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("sends analytics_disabled once with via=config and flushes", async () => {
    const posthog = {
      capture: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    await reportAnalyticsOptOut({
      stateDir: dir,
      version: "1.0.0",
      via: "config",
      posthog,
    });
    expect(posthog.capture).toHaveBeenCalledTimes(1);
    const arg = posthog.capture.mock.calls[0][0];
    expect(arg.event).toBe("analytics_disabled");
    expect(arg.properties.via).toBe("config");
    expect(arg.properties.days_since_install).toBe(0);
    expect(arg.properties.surface).toBeDefined();
    expect(arg.properties.$ip).toBe("0.0.0.0");
    expect(posthog.shutdown).toHaveBeenCalledTimes(1);
  });

  it("is a no-op under the test runner without an injected client", async () => {
    await reportAnalyticsOptOut({ stateDir: dir, version: "1", via: "config" });
    expect(existsSync(join(dir, "analytics.json"))).toBe(false);
  });

  it("never throws when the flush fails", async () => {
    const posthog = {
      capture: vi.fn(),
      shutdown: vi.fn().mockRejectedValue(new Error("offline")),
    };
    await expect(
      reportAnalyticsOptOut({
        stateDir: dir,
        version: "1",
        via: "config",
        posthog,
      }),
    ).resolves.toBeUndefined();
  });
});
