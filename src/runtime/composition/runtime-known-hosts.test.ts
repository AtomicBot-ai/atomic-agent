import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addKnownHosts } from "./runtime-known-hosts.js";

describe("addKnownHosts (ATO-2528)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "known-hosts-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps new hosts in the config file, normalised, once", async () => {
    const file = join(dir, "config.json");
    expect(addKnownHosts(file, ["GitHub.com", "registry.npmjs.org"])).toEqual(["github.com", "registry.npmjs.org"]);
    expect(addKnownHosts(file, ["github.com"])).toEqual(["github.com", "registry.npmjs.org"]);
    // A point edit: only the key is written, not every default.
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      agent: { security: { knownHosts: ["github.com", "registry.npmjs.org"] } },
    });
  });

  it("drops what is not a host name", () => {
    const file = join(dir, "config.json");
    expect(addKnownHosts(file, ["$HOST", "https://x.example"])).toEqual([]);
  });
});
