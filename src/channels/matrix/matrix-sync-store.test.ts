import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MatrixSyncStore } from "./matrix-sync-store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atomic-matrix-sync-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("MatrixSyncStore", () => {
  it("round-trips next_batch for the same account", () => {
    const store = new MatrixSyncStore(join(dir, "matrix-sync.json"));
    expect(store.load("@bot:x")).toBeNull();
    store.save("@bot:x", "s72594_4483_1934");
    expect(store.load("@bot:x")).toBe("s72594_4483_1934");
  });

  it("ignores a position saved for another account", () => {
    const store = new MatrixSyncStore(join(dir, "matrix-sync.json"));
    store.save("@old:x", "s1");
    expect(store.load("@bot:x")).toBeNull();
  });

  it("reads a corrupt file as nothing stored", () => {
    const path = join(dir, "matrix-sync.json");
    writeFileSync(path, "{not json");
    expect(new MatrixSyncStore(path).load("@bot:x")).toBeNull();
  });
});
