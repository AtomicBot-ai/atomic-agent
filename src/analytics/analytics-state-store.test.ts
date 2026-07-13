import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AnalyticsStateStore } from "./analytics-state-store.js";

describe("AnalyticsStateStore", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-analytics-"));
    file = join(dir, "analytics.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("mints an anonymous install id and clears both flags on a fresh install", () => {
    const store = new AnalyticsStateStore(file);
    expect(store.getInstallId()).toMatch(/[0-9a-f-]{36}/);
    expect(store.isAppInstalledSent()).toBe(false);
    expect(store.isFirstMessageSent()).toBe(false);
  });

  it("persists the install id across reloads", () => {
    const first = new AnalyticsStateStore(file).getInstallId();
    const second = new AnalyticsStateStore(file).getInstallId();
    expect(second).toBe(first);
  });

  it("marks flags idempotently and persists them", () => {
    const store = new AnalyticsStateStore(file);
    store.markAppInstalledSent();
    store.markAppInstalledSent();
    store.markFirstMessageSent();
    expect(store.isAppInstalledSent()).toBe(true);
    expect(store.isFirstMessageSent()).toBe(true);

    const reloaded = new AnalyticsStateStore(file);
    expect(reloaded.isAppInstalledSent()).toBe(true);
    expect(reloaded.isFirstMessageSent()).toBe(true);
  });

  it("stores no machine-derived data — only id + boolean flags", () => {
    const store = new AnalyticsStateStore(file);
    store.markFirstMessageSent();
    const persisted = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(persisted).sort()).toEqual([
      "appInstalledSent",
      "firstMessageSent",
      "installId",
    ]);
  });
});
