import { describe, expect, it } from "vitest";
import {
  DEFAULT_SLOTS,
  MAX_AUTO_SLOTS,
  MIN_GPU_SLOTS,
  MIN_SLOT_CONTEXT,
  resolveConfiguredSlots,
  resolveWorkerSlots,
} from "./worker-slots.js";

describe("resolveWorkerSlots", () => {
  it("gives one slot per worth-having share of the context", () => {
    // The context is divided between slots, so the count is how many
    // times a usable slot fits in what the daemon was given.
    expect(resolveWorkerSlots({ contextSize: MIN_SLOT_CONTEXT * 3, cpuOnly: false })).toBe(3);
    expect(
      resolveWorkerSlots({ contextSize: MIN_SLOT_CONTEXT * 3 + 5_000, cpuOnly: false }),
    ).toBe(3);
  });

  it("never falls to a fan-out of one on a GPU", () => {
    // A fan-out of one is the orchestrator queueing behind itself: all
    // of the delegation overhead, none of the parallelism. The old
    // formula produced exactly that on a 12B model's ~16k context, and
    // the run it ruined ended with the orchestrator doing the work
    // itself. Two narrow slots beat one wide one here, because a
    // truncated worker comes back as a task to re-delegate while a
    // serialised one comes back as a timeout.
    expect(resolveWorkerSlots({ contextSize: 4_096, cpuOnly: false })).toBe(
      MIN_GPU_SLOTS,
    );
    expect(
      resolveWorkerSlots({ contextSize: MIN_SLOT_CONTEXT, cpuOnly: false }),
    ).toBe(MIN_GPU_SLOTS);
    expect(
      resolveWorkerSlots({ contextSize: 16_384, cpuOnly: false }),
    ).toBe(MIN_GPU_SLOTS);
  });

  it("stops at the ceiling on a very large context", () => {
    expect(
      resolveWorkerSlots({ contextSize: MIN_SLOT_CONTEXT * 40, cpuOnly: false }),
    ).toBe(MAX_AUTO_SLOTS);
  });

  it("serves one at a time on CPU", () => {
    // Concurrency on shared cores buys nothing: both legs finish at the
    // same time, both late.
    expect(
      resolveWorkerSlots({ contextSize: MIN_SLOT_CONTEXT * 8, cpuOnly: true }),
    ).toBe(1);
  });

  it("falls back to the historical default when the context is unknown", () => {
    // No `--ctx-size` flag: llama.cpp picks, and this process does not
    // learn the number. Guessing high here would be guessing with the
    // operator's memory.
    expect(resolveWorkerSlots({ contextSize: null, cpuOnly: false })).toBe(DEFAULT_SLOTS);
    expect(resolveWorkerSlots({ contextSize: 0, cpuOnly: false })).toBe(DEFAULT_SLOTS);
  });
});

describe("resolveConfiguredSlots", () => {
  it("asks the machine for auto", () => {
    expect(
      resolveConfiguredSlots("auto", { contextSize: MIN_SLOT_CONTEXT * 4, cpuOnly: false }),
    ).toBe(4);
  });

  it("honours a pinned number as written", () => {
    // The escape hatch: an external server, an unusual model, a
    // benchmark. A pin the runtime second-guessed would not be one.
    expect(
      resolveConfiguredSlots(6, { contextSize: MIN_SLOT_CONTEXT, cpuOnly: false }),
    ).toBe(6);
    expect(resolveConfiguredSlots(1, { contextSize: null, cpuOnly: true })).toBe(1);
  });
});
