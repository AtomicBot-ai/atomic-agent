import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AnalyticsClient } from "./analytics-client.js";
import {
  ANALYTICS_EVENTS,
  captureAnalyticsDisabled,
  captureAppInstalled,
  captureAppOpened,
} from "./analytics-events.js";
import { AnalyticsStateStore } from "./analytics-state-store.js";

function fakeClient() {
  return {
    capture: vi.fn(),
    captureConfirmed: vi.fn(async () => true),
  } as unknown as AnalyticsClient & {
    capture: ReturnType<typeof vi.fn>;
    captureConfirmed: ReturnType<typeof vi.fn>;
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

  it("app_installed carries install_channel and other_surface_installed", async () => {
    const client = fakeClient();
    await captureAppInstalled(client, store, {
      installChannel: "curl_sh",
      otherSurfaceInstalled: true,
    });
    expect(client.captureConfirmed).toHaveBeenCalledWith(ANALYTICS_EVENTS.appInstalled, {
      install_channel: "curl_sh",
      other_surface_installed: true,
    });
  });

  it("terminal first, then desktop: two app_installed, then none on restart (ATO-1227)", async () => {
    const file = join(dir, "analytics.json");
    const client = fakeClient();

    // Terminal installs first.
    await captureAppInstalled(client, new AnalyticsStateStore(file), {
      installChannel: "curl_sh",
      surface: "tui",
    });
    // Then the desktop, sharing the same folder and file.
    await captureAppInstalled(client, new AnalyticsStateStore(file), {
      installChannel: "dmg",
      surface: "desktop",
    });
    expect(client.captureConfirmed).toHaveBeenCalledTimes(2);
    expect(client.captureConfirmed).toHaveBeenNthCalledWith(
      1,
      ANALYTICS_EVENTS.appInstalled,
      { install_channel: "curl_sh", other_surface_installed: false },
    );
    expect(client.captureConfirmed).toHaveBeenNthCalledWith(
      2,
      ANALYTICS_EVENTS.appInstalled,
      { install_channel: "dmg", other_surface_installed: true },
    );

    // Restart both: nothing new.
    await captureAppInstalled(client, new AnalyticsStateStore(file), {
      surface: "tui",
    });
    await captureAppInstalled(client, new AnalyticsStateStore(file), {
      surface: "desktop",
    });
    expect(client.captureConfirmed).toHaveBeenCalledTimes(2);
  });

  it("desktop first, then terminal: the terminal reports other_surface_installed", async () => {
    const file = join(dir, "analytics.json");
    const client = fakeClient();
    await captureAppInstalled(client, new AnalyticsStateStore(file), {
      surface: "desktop",
    });
    await captureAppInstalled(client, new AnalyticsStateStore(file), {
      surface: "cli",
    });
    expect(client.captureConfirmed).toHaveBeenNthCalledWith(
      2,
      ANALYTICS_EVENTS.appInstalled,
      { other_surface_installed: true },
    );
  });

  it("an old state file with only appInstalledSent still lets the desktop report once", async () => {
    const file = join(dir, "analytics.json");
    writeFileSync(
      file,
      JSON.stringify({
        installId: "11111111-2222-4333-8444-555555555555",
        appInstalledSent: true,
        firstMessageSent: true,
      }),
      "utf8",
    );
    const client = fakeClient();
    await captureAppInstalled(client, new AnalyticsStateStore(file), {
      surface: "desktop",
    });
    await captureAppInstalled(client, new AnalyticsStateStore(file), {
      surface: "desktop",
    });
    await captureAppInstalled(client, new AnalyticsStateStore(file), {
      surface: "tui",
    });
    expect(client.captureConfirmed).toHaveBeenCalledTimes(1);
    expect(client.captureConfirmed).toHaveBeenCalledWith(
      ANALYTICS_EVENTS.appInstalled,
      { other_surface_installed: true },
    );
  });

  it("an undelivered desktop app_installed leaves the flag unset", async () => {
    const file = join(dir, "analytics.json");
    const offline = fakeClient();
    offline.captureConfirmed.mockResolvedValue(false);
    await captureAppInstalled(offline, new AnalyticsStateStore(file), {
      surface: "desktop",
    });
    expect(new AnalyticsStateStore(file).isAppInstalledSent("desktop")).toBe(false);
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

describe("captureAppOpened", () => {
  it("fires on every call — it is per-launch, not per-install", () => {
    const client = fakeClient();
    captureAppOpened(client);
    captureAppOpened(client);
    expect(client.capture).toHaveBeenCalledTimes(2);
    expect(client.capture).toHaveBeenCalledWith(ANALYTICS_EVENTS.appOpened);
  });

  it("no-ops when analytics is disabled (null client)", () => {
    expect(() => captureAppOpened(null)).not.toThrow();
  });

  it("carries no properties — platform and app_version come from the client", () => {
    const client = fakeClient();
    captureAppOpened(client);
    expect(client.capture.mock.calls[0]).toHaveLength(1);
  });
});
