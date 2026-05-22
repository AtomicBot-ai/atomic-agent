import { describe, it, expect, beforeEach } from "vitest";

import {
  COMPETITOR_FACTORIES,
  probeAdapterRequirements,
  mem0Factory,
  zepFactory,
  langMemFactory,
} from "./index.js";

describe("COMPETITOR_FACTORIES", () => {
  it("registers all three known adapters with unique names", () => {
    const names = COMPETITOR_FACTORIES.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(["mem0", "zep", "langmem"]));
  });

  it("every factory exposes a non-empty requirements list", () => {
    for (const f of COMPETITOR_FACTORIES) {
      expect(f.requirements.envVars.length).toBeGreaterThan(0);
      expect(f.requirements.description?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe("probeAdapterRequirements", () => {
  // Snapshot + reset env in the suite so unrelated env vars don't pollute.
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const f of COMPETITOR_FACTORIES) {
      for (const k of f.requirements.envVars) delete process.env[k];
    }
  });

  it("reports every missing env var, sorted", () => {
    const missing = probeAdapterRequirements(mem0Factory);
    expect(missing).toEqual(["MEM0_API_KEY"]);
  });

  it("returns an empty list when every required env var is set", () => {
    process.env.MEM0_API_KEY = "test-key";
    expect(probeAdapterRequirements(mem0Factory)).toEqual([]);
  });

  it("treats blank / whitespace env values as missing", () => {
    process.env.MEM0_API_KEY = "   ";
    expect(probeAdapterRequirements(mem0Factory)).toEqual(["MEM0_API_KEY"]);
  });

  it("checks every required key for langmem (two env vars)", () => {
    expect(probeAdapterRequirements(langMemFactory).sort()).toEqual([
      "LANGMEM_BRIDGE_URL",
      "OPENAI_API_KEY",
    ]);
  });
});

describe("factory.create — early refusal when prerequisites missing", () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.MEM0_API_KEY;
    delete process.env.LANGMEM_BRIDGE_URL;
  });

  it("mem0Factory throws when MEM0_API_KEY is absent", async () => {
    await expect(mem0Factory.create({})).rejects.toThrow(/MEM0_API_KEY/);
  });

  it("langMemFactory throws when LANGMEM_BRIDGE_URL is absent", async () => {
    await expect(langMemFactory.create({})).rejects.toThrow(/LANGMEM_BRIDGE_URL/);
  });

  it("zepFactory constructs (HTTP probe is deferred to runtime)", async () => {
    // ZEP_BASE_URL has a default value, so the factory does not refuse —
    // the actual unreachable-server failure surfaces on first ingest().
    const adapter = await zepFactory.create({});
    expect(adapter.name).toBe("zep");
    await adapter.close();
  });
});
