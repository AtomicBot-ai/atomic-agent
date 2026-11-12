import { beforeEach, describe, expect, it, vi } from "vitest";

/* ATO-1213: serve keeps the config it booted with, but its read-only
   /api/local-models/* answers read the file as it is now. */
let onDisk = { tag: "boot" };
vi.mock("./load-config.js", () => ({
  loadConfig: vi.fn(() => {
    if (onDisk.tag === "broken") throw new Error("config.json does not parse");
    return { ...onDisk, dotenv: { from: onDisk.tag } };
  }),
}));

const { getConfig, resetConfigCache, withFreshConfig } = await import("./config-cache.js");
const { loadConfig } = await import("./load-config.js");

describe("withFreshConfig (ATO-1213)", () => {
  beforeEach(() => {
    onDisk = { tag: "boot" };
    resetConfigCache();
  });

  it("answers the file as it is now inside, and leaves the cache alone outside", async () => {
    expect((getConfig() as unknown as { tag: string }).tag).toBe("boot");
    onDisk = { tag: "after-models-use" };
    const inside = await withFreshConfig(async () => {
      await Promise.resolve();   // still the fresh one after an await
      return (getConfig() as unknown as { tag: string }).tag;
    });
    expect(inside).toBe("after-models-use");
    expect((getConfig() as unknown as { tag: string }).tag).toBe("boot");
  });

  it("does not leak into work started beside it", async () => {
    getConfig();
    onDisk = { tag: "fresh" };
    let beside = "";
    await Promise.all([
      withFreshConfig(async () => { await new Promise((r) => setTimeout(r, 5)); }),
      (async () => { beside = (getConfig() as unknown as { tag: string }).tag; })(),
    ]);
    expect(beside).toBe("boot");
  });

  it("a file that does not load now falls back to the cached config", async () => {
    getConfig();
    onDisk = { tag: "broken" };
    const inside = await withFreshConfig(async () => (getConfig() as unknown as { tag: string }).tag);
    expect(inside).toBe("boot");
  });

  // Review round: the fresh read is the pure one (no .env merge, no config.json write, no registry push),
  // and it reports the .env serve booted with.
  it("reads read-only, with the dotenv of the cached config", async () => {
    const boot = getConfig() as unknown as { dotenv: unknown };
    vi.mocked(loadConfig).mockClear();
    onDisk = { tag: "now" };
    await withFreshConfig(async () => {});
    expect(vi.mocked(loadConfig).mock.calls).toEqual([[{ readOnly: { dotenv: boot.dotenv } }]]);
  });
});
