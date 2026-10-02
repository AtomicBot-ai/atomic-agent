import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AnalyticsClient } from "./analytics-client.js";
import {
  ANALYTICS_EVENTS,
  captureAnalyticsDisabled,
  captureAppInstalled,
} from "./analytics-events.js";
import { AnalyticsStateStore } from "./analytics-state-store.js";

function fakeClient() {
  return { capture: vi.fn() } as unknown as AnalyticsClient & {
    capture: ReturnType<typeof vi.fn>;
  };
}

describe("app_installed / analytics_disabled", () => {
  let dir: string;
  let store: AnalyticsStateStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-lifecycle-"));
    store = new AnalyticsStateStore(join(dir, "analytics.json"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("app_installed carries install_channel and other_surface_installed", () => {
    const client = fakeClient();
    captureAppInstalled(client, store, {
      installChannel: "curl_sh",
      otherSurfaceInstalled: true,
    });
    expect(client.capture).toHaveBeenCalledWith(ANALYTICS_EVENTS.appInstalled, {
      install_channel: "curl_sh",
      other_surface_installed: true,
    });
  });

  it("analytics_disabled carries via and days_since_install for a fresh install", () => {
    const client = fakeClient();
    captureAnalyticsDisabled(client, store, "slash");
    expect(client.capture).toHaveBeenCalledTimes(1);
    expect(client.capture).toHaveBeenCalledWith(
      ANALYTICS_EVENTS.analyticsDisabled,
      { via: "slash", days_since_install: 0 },
    );
  });

  it("analytics_disabled omits days_since_install when the install date is unknown", () => {
    const client = fakeClient();
    const legacy = {
      getDaysSinceInstall: () => undefined,
    } as unknown as AnalyticsStateStore;
    captureAnalyticsDisabled(client, legacy, "settings");
    expect(client.capture).toHaveBeenCalledWith(
      ANALYTICS_EVENTS.analyticsDisabled,
      { via: "settings" },
    );
  });

  it("analytics_disabled is a no-op without a client", () => {
    expect(() => captureAnalyticsDisabled(null, store, "config")).not.toThrow();
  });
});
