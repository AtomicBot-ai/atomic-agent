import { describe, expect, it } from "vitest";

import { USER_CONFIG_DEFAULTS } from "../config/config-schema.js";
import { MAX_AUTO_CONTEXT } from "./context-size.js";
import {
  DEFAULT_SLOTS,
  DEFAULT_WORKER_COMPLETION_TOKENS,
  MAX_AUTO_SLOTS,
  WORKER_PROMPT_BASE_TOKENS,
  WORKER_READS_ALLOWANCE_TOKENS,
  resolveConfiguredSlots,
  resolveWorkerSlots,
  workerSlotFootprint,
} from "./worker-slots.js";

const DEFAULT_CAP = USER_CONFIG_DEFAULTS.localModels.completionMaxTokens;

describe("workerSlotFootprint", () => {
  it("is the measured prompt, the reads allowance and the reply cap", () => {
    expect(workerSlotFootprint(8_192)).toBe(
      WORKER_PROMPT_BASE_TOKENS + WORKER_READS_ALLOWANCE_TOKENS + 8_192,
    );
    expect(workerSlotFootprint(8_192)).toBe(24_192);
    expect(workerSlotFootprint(16_384)).toBe(32_384);
  });

  it("covers every worker prompt the benchmark measured before generation", () => {
    // Gemma 4 31B fan-outs: four prompts that together overflowed a
    // 32,768-token unified pool, then two more from a second fan-out.
    for (const prompt of [8_121, 8_292, 8_147, 8_212, 9_300, 10_295]) {
      expect(prompt).toBeLessThanOrEqual(
        WORKER_PROMPT_BASE_TOKENS + WORKER_READS_ALLOWANCE_TOKENS,
      );
    }
  });

  it("uses the schema's default reply cap when the cap is unknown or uncapped", () => {
    // Drift guard: the fallback must be the number the rest of the local
    // path plans against.
    expect(DEFAULT_WORKER_COMPLETION_TOKENS).toBe(DEFAULT_CAP);
    expect(workerSlotFootprint()).toBe(workerSlotFootprint(DEFAULT_CAP));
    expect(workerSlotFootprint(0)).toBe(workerSlotFootprint(DEFAULT_CAP));
  });
});

describe("resolveWorkerSlots", () => {
  it("counts whole worker footprints in the unified context", () => {
    const at = (contextSize: number): number =>
      resolveWorkerSlots({ contextSize, cpuOnly: false, completionMaxTokens: 8_192 });
    expect(at(32_768)).toBe(1);
    expect(at(65_536)).toBe(2);
    expect(at(131_072)).toBe(5);
  });

  it("would not have launched the four-worker run that overflowed", () => {
    // The old floor of 8,192 tokens per slot gave that 32,768 context
    // four slots; four ~8.2k prompts filled it before a token came out.
    expect(
      resolveWorkerSlots({ contextSize: 32_768, cpuOnly: false, completionMaxTokens: 8_192 }),
    ).toBeLessThan(4);
  });

  it("serves several workers at the auto-size ceiling", () => {
    expect(
      resolveWorkerSlots({ contextSize: MAX_AUTO_CONTEXT, cpuOnly: false }),
    ).toBeGreaterThanOrEqual(4);
  });

  it("gives fewer slots to a bigger reply cap", () => {
    const at = (completionMaxTokens: number): number =>
      resolveWorkerSlots({ contextSize: 131_072, cpuOnly: false, completionMaxTokens });
    expect(at(8_192)).toBe(5);
    expect(at(16_384)).toBe(4);
    expect(at(32_768)).toBe(2);
    // Uncapped replies are sized at the default, not at zero — zero would
    // hand out the ceiling on a pool that holds four whole workers.
    expect(at(0)).toBe(at(DEFAULT_CAP));
    expect(at(0)).toBe(4);
    expect(at(0)).toBeLessThan(MAX_AUTO_SLOTS);
  });

  it("falls to one, not two, when a context holds a single worker", () => {
    // On a unified pool a second worker that does not fit is not a
    // narrower worker, it is an overflow that fails both.
    expect(resolveWorkerSlots({ contextSize: 4_096, cpuOnly: false })).toBe(1);
    expect(resolveWorkerSlots({ contextSize: 16_384, cpuOnly: false })).toBe(1);
    expect(
      resolveWorkerSlots({ contextSize: workerSlotFootprint() * 2 - 1, cpuOnly: false }),
    ).toBe(1);
  });

  it("stops at the ceiling on a very large context", () => {
    expect(
      resolveWorkerSlots({ contextSize: workerSlotFootprint() * 40, cpuOnly: false }),
    ).toBe(MAX_AUTO_SLOTS);
  });

  it("serves one at a time on CPU", () => {
    // Concurrency on shared cores buys nothing: both legs finish at the
    // same time, both late.
    expect(
      resolveWorkerSlots({ contextSize: workerSlotFootprint() * 8, cpuOnly: true }),
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

describe("resolveWorkerSlots — which leg the local daemon is on", () => {
  const roomy = workerSlotFootprint() * 4;

  it("serves one stream with one slot when the daemon orchestrates", () => {
    // Workers in the cloud: the local side runs exactly one stream, so
    // the extra slots cannot be used by anyone — and they are not free.
    // They split the KV budget, and llama.cpp's longest-common-prefix
    // slot selection can move the one stream to an empty slot between
    // turns and re-ingest a prefix the other slot still holds.
    expect(
      resolveWorkerSlots({
        contextSize: roomy,
        cpuOnly: false,
        localLegRole: "orchestrator",
      }),
    ).toBe(1);
    // No context is large enough to make an unusable slot worth having.
    expect(
      resolveWorkerSlots({
        contextSize: workerSlotFootprint() * 40,
        cpuOnly: false,
        localLegRole: "orchestrator",
      }),
    ).toBe(1);
    // Not even an unknown context, where the historical fallback is two.
    expect(
      resolveWorkerSlots({
        contextSize: null,
        cpuOnly: false,
        localLegRole: "orchestrator",
      }),
    ).toBe(1);
  });

  it("counts the memory fit as before when the daemon serves workers", () => {
    // Aggregate throughput is what a fan-out needs, and concurrency buys
    // it: gemma-4-26b-a4b measured ~4.8 tok/s on a single active stream
    // against ~9.5 tok/s aggregate across two.
    const fit = resolveWorkerSlots({ contextSize: roomy, cpuOnly: false });
    expect(fit).toBe(4);
    expect(
      resolveWorkerSlots({
        contextSize: roomy,
        cpuOnly: false,
        localLegRole: "workers",
      }),
    ).toBe(fit);
  });

  it("leaves every no-fusion launch exactly where it was", () => {
    // Regression pin: an omitted role is `"workers"`, which is what
    // `local` and `cloud` modes can only ever mean.
    for (const contextSize of [null, 0, 16_384, 65_536, roomy]) {
      for (const cpuOnly of [false, true]) {
        expect(
          resolveWorkerSlots({ contextSize, cpuOnly, localLegRole: "workers" }),
        ).toBe(resolveWorkerSlots({ contextSize, cpuOnly }));
      }
    }
  });
});

describe("resolveConfiguredSlots", () => {
  it("asks the machine for auto", () => {
    expect(
      resolveConfiguredSlots("auto", { contextSize: workerSlotFootprint() * 4, cpuOnly: false }),
    ).toBe(4);
  });

  it("honours a pinned number as written", () => {
    // The escape hatch: an external server, an unusual model, a
    // benchmark. A pin the runtime second-guessed would not be one.
    expect(
      resolveConfiguredSlots(6, { contextSize: 16_384, cpuOnly: false }),
    ).toBe(6);
    expect(resolveConfiguredSlots(1, { contextSize: null, cpuOnly: true })).toBe(1);
  });

  it("keeps a pinned number authoritative while the daemon orchestrates", () => {
    // The role steers `"auto"` only. An operator who wrote a number
    // still gets that number — otherwise the escape hatch would close
    // the moment the legs were swapped.
    expect(
      resolveConfiguredSlots(2, {
        contextSize: workerSlotFootprint() * 4,
        cpuOnly: false,
        localLegRole: "orchestrator",
      }),
    ).toBe(2);
    expect(
      resolveConfiguredSlots("auto", {
        contextSize: workerSlotFootprint() * 4,
        cpuOnly: false,
        localLegRole: "orchestrator",
      }),
    ).toBe(1);
  });
});
