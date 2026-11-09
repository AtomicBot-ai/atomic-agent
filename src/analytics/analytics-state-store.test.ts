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
      "appInstalledSentDesktop",
      "firstMessageSent",
      "firstMessageSentDesktop",
      "installId",
      "installedAt",
      "modelConfiguredSent",
      "modelConfiguredSentDesktop",
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

  it("keeps a separate app_installed flag for the desktop", () => {
    const store = new AnalyticsStateStore(file);
    store.markAppInstalledSent("tui");
    expect(store.isAppInstalledSent("tui")).toBe(true);
    expect(store.isAppInstalledSent("cli")).toBe(true);
    expect(store.isAppInstalledSent()).toBe(true);
    expect(store.isAppInstalledSent("desktop")).toBe(false);
    expect(store.isOtherSurfaceAppInstalledSent("desktop")).toBe(true);
    expect(store.isOtherSurfaceAppInstalledSent("tui")).toBe(false);

    store.markAppInstalledSent("desktop");
    const reloaded = new AnalyticsStateStore(file);
    expect(reloaded.isAppInstalledSent("desktop")).toBe(true);
    expect(reloaded.isAppInstalledSent("tui")).toBe(true);
    expect(reloaded.isOtherSurfaceAppInstalledSent("tui")).toBe(true);
  });

  it("reads a file from before the desktop flag: terminal sent, desktop not", () => {
    const legacyId = "11111111-2222-4333-8444-555555555555";
    writeFileSync(
      file,
      JSON.stringify({
        installId: legacyId,
        appInstalledSent: true,
        firstMessageSent: false,
        modelConfiguredSent: false,
      }),
      "utf8",
    );
    const store = new AnalyticsStateStore(file);
    expect(store.getInstallId()).toBe(legacyId);
    expect(store.isAppInstalledSent("tui")).toBe(true);
    expect(store.isAppInstalledSent("desktop")).toBe(false);
  });

  it("never clears a flag another process set after this one loaded", () => {
    // Desktop and terminal share the file and may run at the same time.
    const desktop = new AnalyticsStateStore(file);
    const terminal = new AnalyticsStateStore(file);
    terminal.markAppInstalledSent("tui");
    // The desktop process still holds its stale view; writing it back
    // must not undo the terminal's flag.
    desktop.markAppInstalledSent("desktop");
    desktop.markFirstMessageSent();
    const persisted = JSON.parse(readFileSync(file, "utf8"));
    expect(persisted.appInstalledSent).toBe(true);
    expect(persisted.appInstalledSentDesktop).toBe(true);
    expect(persisted.firstMessageSent).toBe(true);
    // And the stale process sees the other flag when asked.
    expect(desktop.isOtherSurfaceAppInstalledSent("desktop")).toBe(true);
  });

  it("keeps first_message_sent and model_configured per surface (ATO-1262)", () => {
    const terminal = new AnalyticsStateStore(file, { surface: "tui" });
    const desktop = new AnalyticsStateStore(file, { surface: "desktop" });
    terminal.markFirstMessageSent();
    terminal.markModelConfiguredSent();
    // The terminal reporting first no longer hides the desktop's events.
    expect(desktop.isFirstMessageSent()).toBe(false);
    expect(desktop.isModelConfiguredSent()).toBe(false);
    desktop.markFirstMessageSent();
    desktop.markModelConfiguredSent();
    const persisted = JSON.parse(readFileSync(file, "utf8"));
    expect(persisted.firstMessageSent).toBe(true);
    expect(persisted.firstMessageSentDesktop).toBe(true);
    expect(persisted.modelConfiguredSent).toBe(true);
    expect(persisted.modelConfiguredSentDesktop).toBe(true);
    // `cli` shares the terminal's flags; an explicit surface wins over the default.
    const cli = new AnalyticsStateStore(file, { surface: "cli" });
    expect(cli.isFirstMessageSent()).toBe(true);
    expect(cli.isFirstMessageSent("desktop")).toBe(true);
  });

  it("reads a pre-ATO-1262 file as terminal reported, desktop not", () => {
    const id = "11111111-2222-4333-8444-555555555555";
    writeFileSync(
      file,
      JSON.stringify({ installId: id, appInstalledSent: true, firstMessageSent: true, modelConfiguredSent: true }),
      "utf8",
    );
    expect(new AnalyticsStateStore(file, { surface: "tui" }).isFirstMessageSent()).toBe(true);
    const desktop = new AnalyticsStateStore(file, { surface: "desktop" });
    expect(desktop.isFirstMessageSent()).toBe(false);
    expect(desktop.isModelConfiguredSent()).toBe(false);
    // No surface at all keeps the old behaviour: the terminal's flags.
    expect(new AnalyticsStateStore(file).isFirstMessageSent()).toBe(true);
  });

  it("sees a first message the same surface sent from another process", () => {
    const a = new AnalyticsStateStore(file, { surface: "desktop" });
    const b = new AnalyticsStateStore(file, { surface: "desktop" });
    a.markFirstMessageSent();
    expect(b.isFirstMessageSent()).toBe(true);
  });

  it("keeps keys a newer build wrote", () => {
    const id = "11111111-2222-4333-8444-555555555555";
    writeFileSync(
      file,
      JSON.stringify({ installId: id, appInstalledSent: true, futureFlag: true }),
      "utf8",
    );
    const store = new AnalyticsStateStore(file);
    store.markFirstMessageSent();
    const persisted = JSON.parse(readFileSync(file, "utf8"));
    expect(persisted.futureFlag).toBe(true);
    expect(persisted.installId).toBe(id);
  });
});
