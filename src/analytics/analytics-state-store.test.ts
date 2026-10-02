import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("mints an anonymous install id and clears every flag on a fresh install", () => {
    const store = new AnalyticsStateStore(file);
    expect(store.getInstallId()).toMatch(/[0-9a-f-]{36}/);
    expect(store.isAppInstalledSent()).toBe(false);
    expect(store.isFirstMessageSent()).toBe(false);
    expect(store.isModelConfiguredSent()).toBe(false);
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
    store.markModelConfiguredSent();
    store.markModelConfiguredSent();
    expect(store.isAppInstalledSent()).toBe(true);
    expect(store.isFirstMessageSent()).toBe(true);
    expect(store.isModelConfiguredSent()).toBe(true);

    const reloaded = new AnalyticsStateStore(file);
    expect(reloaded.isAppInstalledSent()).toBe(true);
    expect(reloaded.isFirstMessageSent()).toBe(true);
    expect(reloaded.isModelConfiguredSent()).toBe(true);
  });

  it("stores no machine-derived data — only id, install time + boolean flags", () => {
    const store = new AnalyticsStateStore(file);
    store.markFirstMessageSent();
    const persisted = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(persisted).sort()).toEqual([
      "appInstalledSent",
      "firstMessageSent",
      "installId",
      "installedAt",
      "modelConfiguredSent",
    ]);
  });

  it("records installedAt on a fresh install and reports whole days since", () => {
    const store = new AnalyticsStateStore(file);
    const persisted = JSON.parse(readFileSync(file, "utf8"));
    const at = Date.parse(persisted.installedAt);
    expect(Number.isFinite(at)).toBe(true);
    expect(store.getDaysSinceInstall(at)).toBe(0);
    expect(store.getDaysSinceInstall(at + 3.5 * 24 * 60 * 60 * 1000)).toBe(3);
  });

  it("does not backfill installedAt for a file that predates it", () => {
    writeFileSync(
      file,
      JSON.stringify({ installId: "11111111-2222-4333-8444-555555555555" }),
      "utf8",
    );
    const store = new AnalyticsStateStore(file);
    expect(store.getDaysSinceInstall()).toBeUndefined();
  });

  it("returns the local id as the shared id while analytics is disabled", () => {
    const store = new AnalyticsStateStore(file);
    expect(store.getSharedInstallId(false)).toBe(store.getInstallId());
  });

  it("reads a pre-existing file that predates modelConfiguredSent", () => {
    // A file written before `model_configured` existed: the id and the
    // two original flags must survive, and the new flag starts false so
    // an already-set-up install still reports its next verified save.
    const legacyId = "11111111-2222-3333-4444-555555555555";
    writeFileSync(
      file,
      JSON.stringify({
        installId: legacyId,
        appInstalledSent: true,
        firstMessageSent: true,
      }),
      "utf8",
    );
    const store = new AnalyticsStateStore(file);
    expect(store.getInstallId()).toBe(legacyId);
    expect(store.isAppInstalledSent()).toBe(true);
    expect(store.isFirstMessageSent()).toBe(true);
    expect(store.isModelConfiguredSent()).toBe(false);
  });
});
