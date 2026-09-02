import { describe, expect, it, vi } from "vitest";

import { DeferredLocalBackendProbes } from "./local-backend-gate.js";

describe("DeferredLocalBackendProbes", () => {
  it("never restores when boot already probed (local-from-boot run)", async () => {
    const restore = vi.fn(async () => {});
    const gate = new DeferredLocalBackendProbes(
      { isActive: () => true, restore },
      true,
    );
    expect(await gate.ensureProbed()).toBe(false);
    expect(await gate.ensureProbed()).toBe(false);
    expect(restore).toHaveBeenCalledTimes(0);
  });

  it("restores exactly once, and only the winner may skip its own refresh", async () => {
    const restore = vi.fn(async () => {});
    const gate = new DeferredLocalBackendProbes(
      { isActive: () => true, restore },
      false,
    );
    expect(await gate.ensureProbed()).toBe(true);
    expect(await gate.ensureProbed()).toBe(false);
    expect(await gate.ensureProbed()).toBe(false);
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it("a concurrent caller waits for the restore but does not claim it", async () => {
    // Turn start racing a mid-turn fallover: both must see warm state
    // when they proceed, and only one may report "a fresh /props landed".
    let release!: () => void;
    const started = vi.fn();
    const gate = new DeferredLocalBackendProbes(
      {
        isActive: () => true,
        restore: () =>
          new Promise<void>((resolve) => {
            started();
            release = resolve;
          }),
      },
      false,
    );

    const first = gate.ensureProbed();
    const second = gate.ensureProbed();
    expect(started).toHaveBeenCalledTimes(1);
    release();

    expect(await first).toBe(true);
    expect(await second).toBe(false);
  });

  it("latches after a throwing restore so the probes cannot re-arm every step", async () => {
    const restore = vi.fn(async () => {
      throw new Error("llama-server is down");
    });
    const gate = new DeferredLocalBackendProbes(
      { isActive: () => true, restore },
      false,
    );
    await expect(gate.ensureProbed()).rejects.toThrow("llama-server is down");
    expect(await gate.ensureProbed()).toBe(false);
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it("reads `isActive` per call so a hot switch is observed", () => {
    let active = false;
    const gate = new DeferredLocalBackendProbes(
      { isActive: () => active, restore: async () => {} },
      false,
    );
    expect(gate.isActive()).toBe(false);
    active = true;
    expect(gate.isActive()).toBe(true);
  });
});
