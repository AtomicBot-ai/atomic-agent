import { describe, expect, it, vi } from "vitest";

import type { ProviderCapabilities } from "../llm/provider/llm-provider.js";
import type { LogbookCaptureOutcome } from "./logbook-capture.js";
import type { LogbookVisionProvider, PickLocalVisionResult } from "./logbook-local-vision.js";
import { DEFAULT_LOGBOOK_SETTINGS, type LogbookSettings } from "./logbook-settings.js";
import type { IndicatorState } from "./logbook-indicator.js";
import { createLogbookSidecar, INDICATOR_AWAY_REASON, INDICATOR_HIDDEN_REASON, PRUNE_EVERY_MS } from "./logbook-sidecar.js";
import { EMPTY_LOGBOOK_STATUS, type LogbookStatus } from "./logbook-status.js";
import type { LogbookEntry } from "./logbook-store.js";

const LOCAL: LogbookVisionProvider = {
  id: "local-llama",
  name: "llama-server",
  capabilities: { vision: true, visionSource: "mmproj" } as ProviderCapabilities,
  describeImage: async () => ({ text: "x", durationMs: 1 }),
};

const ENTRY: LogbookEntry = { at: "2026-11-27T13:00:00.000Z", app: "TextEdit", bundleId: "com.apple.TextEdit", text: "writing" };

function setup(options: { settings?: Partial<LogbookSettings>; pick?: PickLocalVisionResult; outcome?: LogbookCaptureOutcome; mark?: IndicatorState } = {}) {
  let mark: IndicatorState | undefined = options.mark;
  let settings: LogbookSettings = { ...DEFAULT_LOGBOOK_SETTINGS, excludeApps: [], enabled: true, ...options.settings };
  let status: LogbookStatus = { ...EMPTY_LOGBOOK_STATUS };
  const appended: LogbookEntry[] = [];
  const capture = vi.fn(async (): Promise<LogbookCaptureOutcome> => options.outcome ?? { kind: "captured", entry: ENTRY });
  const prune = vi.fn(() => [] as string[]);
  const sidecar = createLogbookSidecar({
    stateDir: "/state",
    resolveProvider: () => options.pick ?? { ok: true, provider: LOCAL },
    capture,
    readSettings: () => settings,
    readStatus: () => status,
    writeStatus: (_dir, next) => {
      status = next;
    },
    append: (_dir, entry) => {
      appended.push(entry);
    },
    prune,
    ...(mark === undefined ? {} : { indicator: () => mark as IndicatorState }),
  });
  return {
    sidecar,
    capture,
    prune,
    appended,
    status: () => status,
    setSettings: (patch: Partial<LogbookSettings>) => {
      settings = { ...settings, ...patch };
    },
    setMark: (next: IndicatorState) => {
      mark = next;
    },
  };
}

const signal = () => new AbortController().signal;
const T0 = 1_800_000_000_000;

describe("logbook sidecar", () => {
  it("captures nothing while the logbook is off (the default)", async () => {
    const s = setup({ settings: { enabled: false } });
    await s.sidecar.tick(T0, signal());
    expect(s.capture).not.toHaveBeenCalled();
    expect(s.appended).toEqual([]);
  });

  it("captures on the first tick, then waits a whole interval", async () => {
    const s = setup({ settings: { intervalMinutes: 5 } });
    await s.sidecar.tick(T0, signal());
    await s.sidecar.tick(T0 + 4 * 60_000, signal());
    expect(s.capture).toHaveBeenCalledTimes(1);
    await s.sidecar.tick(T0 + 5 * 60_000, signal());
    expect(s.capture).toHaveBeenCalledTimes(2);
    expect(s.appended).toEqual([ENTRY, ENTRY]);
    expect(s.status()).toMatchObject({ lastOutcome: "captured", lastCaptureAt: T0 + 5 * 60_000, provider: "local-llama" });
  });

  it("stops capturing from the next tick after a stop or during a pause", async () => {
    const s = setup({ settings: { intervalMinutes: 1 } });
    await s.sidecar.tick(T0, signal());
    s.setSettings({ enabled: false });
    await s.sidecar.tick(T0 + 60_000, signal());
    s.setSettings({ enabled: true, pausedUntil: T0 + 10 * 60_000 });
    await s.sidecar.tick(T0 + 2 * 60_000, signal());
    expect(s.capture).toHaveBeenCalledTimes(1);
  });

  it("takes no screenshot and says why when no local vision model is there", async () => {
    const s = setup({ pick: { ok: false, reason: "no local vision model is loaded" } });
    await s.sidecar.tick(T0, signal());
    expect(s.capture).not.toHaveBeenCalled();
    expect(s.status()).toMatchObject({ lastOutcome: "skipped", lastReason: "no local vision model is loaded", provider: null });
  });

  it("records a skip without storing anything", async () => {
    const s = setup({ outcome: { kind: "skipped", reason: "a password or login window is in front" } });
    await s.sidecar.tick(T0, signal());
    expect(s.appended).toEqual([]);
    expect(s.status()).toMatchObject({ lastOutcome: "skipped", lastReason: "a password or login window is in front" });
  });

  it("drops a frame described after the logbook was stopped", async () => {
    const s = setup();
    s.capture.mockImplementationOnce(async () => {
      s.setSettings({ enabled: false });
      return { kind: "captured", entry: ENTRY };
    });
    await s.sidecar.tick(T0, signal());
    expect(s.appended).toEqual([]);
    expect(s.status().lastOutcome).toBe("skipped");
  });

  it("prunes old days once an hour, even while off", async () => {
    const s = setup({ settings: { enabled: false, retentionDays: 7 } });
    await s.sidecar.tick(T0, signal());
    await s.sidecar.tick(T0 + 60_000, signal());
    expect(s.prune).toHaveBeenCalledTimes(1);
    expect((s.prune.mock.calls[0] as unknown[])[1]).toBe(7);
    await s.sidecar.tick(T0 + PRUNE_EVERY_MS, signal());
    expect(s.prune).toHaveBeenCalledTimes(2);
  });

  it("never runs two captures at once", async () => {
    const s = setup({ settings: { intervalMinutes: 1 } });
    let release: () => void = () => undefined;
    s.capture.mockImplementationOnce(
      () => new Promise<LogbookCaptureOutcome>((resolve) => {
        release = () => resolve({ kind: "captured", entry: ENTRY });
      }),
    );
    const first = s.sidecar.tick(T0, signal());
    expect(s.sidecar.busy()).toBe(true);
    await s.sidecar.tick(T0 + 2 * 60_000, signal());
    release();
    await first;
    expect(s.capture).toHaveBeenCalledTimes(1);
    expect(s.sidecar.busy()).toBe(false);
  });

  describe("the visible mark (ATO-2534)", () => {
    it("captures nothing while the frontend's mark is not on screen, and says so once", async () => {
      const s = setup({ mark: "hidden" });
      await s.sidecar.tick(T0, signal());
      expect(s.capture).not.toHaveBeenCalled();
      expect(s.status()).toMatchObject({ lastOutcome: "skipped", lastReason: INDICATOR_HIDDEN_REASON });
    });

    it("captures soon after the mark shows, without waiting a whole interval", async () => {
      const s = setup({ mark: "hidden", settings: { intervalMinutes: 5 } });
      await s.sidecar.tick(T0, signal());
      s.setMark("visible");
      await s.sidecar.tick(T0 + 5_000, signal());
      expect(s.capture).toHaveBeenCalledTimes(1);
      expect(s.appended).toEqual([ENTRY]);
    });

    it("skips the frame while the person is away", async () => {
      const s = setup({ mark: "away" });
      await s.sidecar.tick(T0, signal());
      expect(s.capture).not.toHaveBeenCalled();
      expect(s.status()).toMatchObject({ lastOutcome: "skipped", lastReason: INDICATOR_AWAY_REASON });
    });

    it("drops a frame whose mark went away while it was described", async () => {
      const s = setup({ mark: "visible" });
      s.capture.mockImplementationOnce(async () => {
        s.setMark("hidden");
        return { kind: "captured", entry: ENTRY };
      });
      await s.sidecar.tick(T0, signal());
      expect(s.appended).toEqual([]);
    });
  });
});
