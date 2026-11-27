import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_LOGBOOK_SETTINGS, readLogbookIndicator, readLogbookSettings, writeLogbookSettings } from "../logbook/index.js";
import { startTestHarness, type Harness } from "./test-harness.js";

/** ATO-2534: the desktop's chip reads and changes the logbook through these routes. */
describe("/api/logbook", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startTestHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  const patch = (body: unknown) =>
    fetch(`${harness.baseUrl}/api/logbook/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("answers off by default, with whether this computer can run it", async () => {
    const res = await fetch(`${harness.baseUrl}/api/logbook`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string; platform: { supported: boolean }; days: string[] };
    expect(body.state).toBe("off");
    expect(typeof body.platform.supported).toBe("boolean");
    expect(body.days).toEqual([]);
  });

  it("pauses, resumes and stops, writing settings.json like the CLI", async () => {
    writeLogbookSettings(harness.stateDir, { ...DEFAULT_LOGBOOK_SETTINGS, excludeApps: [], enabled: true });
    const paused = await patch({ action: "pause", minutes: 30 });
    expect(paused.status).toBe(200);
    expect(((await paused.json()) as { state: string }).state).toBe("paused");
    expect(readLogbookSettings(harness.stateDir).pausedUntil).not.toBeNull();

    const resumed = (await (await patch({ action: "resume" })).json()) as { state: string };
    expect(resumed.state).toBe("on");

    const stopped = (await (await patch({ action: "stop" })).json()) as { state: string };
    expect(stopped.state).toBe("off");
    expect(readLogbookSettings(harness.stateDir).enabled).toBe(false);
  });

  it("refuses a pause while off with a plain sentence, and an unknown action", async () => {
    const res = await patch({ action: "pause" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/off/);
    expect((await patch({ action: "erase" })).status).toBe(400);
  });

  it("records the frontend's mark for this process, and clears it", async () => {
    const shown = await fetch(`${harness.baseUrl}/api/logbook/indicator`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ visible: true }),
    });
    expect(shown.status).toBe(200);
    expect(readLogbookIndicator(harness.stateDir)).toMatchObject({ pid: process.pid, away: false });

    await fetch(`${harness.baseUrl}/api/logbook/indicator`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ visible: false }),
    });
    expect(readLogbookIndicator(harness.stateDir)).toBeNull();

    const bad = await fetch(`${harness.baseUrl}/api/logbook/indicator`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ visible: "yes" }),
    });
    expect(bad.status).toBe(400);
  });
});
