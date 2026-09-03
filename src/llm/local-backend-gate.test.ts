import { describe, expect, it, vi } from "vitest";

import {
  createLocalLinkPreparer,
  DeferredLocalBackendProbes,
} from "./local-backend-gate.js";

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

  it("latches after a SYNCHRONOUSLY throwing restore too", async () => {
    // The async-throw test above passes even with the `restore()` call
    // outside the try: the rejection is produced after `inFlight` has
    // been assigned. A sync throw escapes before the assignment, so the
    // latch never armed and every later call re-ran the probes — three
    // `ensureProbed()` calls, three `restore()` calls.
    const restore = vi.fn((): Promise<void> => {
      throw new Error("config read blew up");
    });
    const gate = new DeferredLocalBackendProbes(
      { isActive: () => true, restore },
      false,
    );
    await expect(gate.ensureProbed()).rejects.toThrow("config read blew up");
    expect(await gate.ensureProbed()).toBe(false);
    expect(await gate.ensureProbed()).toBe(false);
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it("take-and-clear reports whether a local link served since the last read", () => {
    const gate = new DeferredLocalBackendProbes(
      { isActive: () => false, restore: async () => {} },
      false,
    );
    // Nothing served yet: a pure cloud turn must not refresh anything.
    expect(gate.takeLinkServed()).toBe(false);

    gate.noteLinkServed();
    expect(gate.takeLinkServed()).toBe(true);
    // Cleared — one refresh per fallover, not one per turn forever.
    expect(gate.takeLinkServed()).toBe(false);

    gate.noteLinkServed();
    gate.noteLinkServed();
    expect(gate.takeLinkServed()).toBe(true);
    expect(gate.takeLinkServed()).toBe(false);
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

describe("createLocalLinkPreparer", () => {
  /**
   * The three decisions bootstrap's `prepareLink` makes. Covered here
   * because deleting any one of them from an inline closure inside
   * `buildRuntime` used to survive every test in the tree.
   */
  const build = (opts: {
    isLocalLink?: (id: string) => boolean;
    probedAtBoot?: boolean;
  } = {}) => {
    const restore = vi.fn(async () => {});
    const refreshIfStale = vi.fn(async () => {});
    const gate = new DeferredLocalBackendProbes(
      { isActive: () => false, restore },
      opts.probedAtBoot ?? false,
    );
    const prepare = createLocalLinkPreparer({
      gate,
      isLocalLink: opts.isLocalLink ?? ((id) => id === "local"),
      refreshIfStale,
    });
    return { gate, prepare, restore, refreshIfStale };
  };

  it("does nothing at all for a link that is not llama-server", async () => {
    const { prepare, gate, restore, refreshIfStale } = build();
    await prepare("cloudy");
    expect(restore).toHaveBeenCalledTimes(0);
    expect(refreshIfStale).toHaveBeenCalledTimes(0);
    // The zero-request criterion in one assertion: a cloud attempt does
    // not even record that a local link served.
    expect(gate.takeLinkServed()).toBe(false);
  });

  it("marks the link served so the loop's turn-start refresh reopens", async () => {
    const { prepare, gate } = build();
    await prepare("local");
    expect(gate.takeLinkServed()).toBe(true);
  });

  it("restores on the first local attempt and does not also refresh", async () => {
    const { prepare, restore, refreshIfStale } = build();
    await prepare("local");
    expect(restore).toHaveBeenCalledTimes(1);
    // The restore's own `/props` just landed; refreshing again would
    // probe twice for one attempt.
    expect(refreshIfStale).toHaveBeenCalledTimes(0);
  });

  it("falls through to refreshIfStale on every later local attempt", async () => {
    // The reactive path the loop's between-steps refresh cannot serve
    // while the active provider is cloud.
    const { prepare, restore, refreshIfStale } = build();
    await prepare("local");
    await prepare("local");
    await prepare("local");
    expect(restore).toHaveBeenCalledTimes(1);
    expect(refreshIfStale).toHaveBeenCalledTimes(2);
  });

  it("refreshes from the very first attempt on a local-from-boot run", async () => {
    // Boot already probed, so there is nothing to restore — but the
    // staleness flag still needs a consumer.
    const { prepare, restore, refreshIfStale } = build({ probedAtBoot: true });
    await prepare("local");
    expect(restore).toHaveBeenCalledTimes(0);
    expect(refreshIfStale).toHaveBeenCalledTimes(1);
  });
});
