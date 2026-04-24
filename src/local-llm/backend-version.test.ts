import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readBackendVersion, writeBackendVersion } from "./backend-version.js";

describe("backend-version", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when missing", () => {
    dir = mkdtempSync(join(tmpdir(), "local-llm-bv-"));
    expect(readBackendVersion(dir)).toBeNull();
  });

  it("round-trips write and read", () => {
    dir = mkdtempSync(join(tmpdir(), "local-llm-bv-"));
    const info = { tag: "v1.0.0", downloadedAt: "2026-01-01T00:00:00.000Z" };
    writeBackendVersion(dir, info);
    expect(readBackendVersion(dir)).toEqual(info);
  });
});
