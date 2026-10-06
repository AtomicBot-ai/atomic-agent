import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readLogTail } from "./log-tail.js";

describe("readLogTail", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "log-tail-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns full content when file is smaller than the tail window", () => {
    const path = join(dir, "small.log");
    writeFileSync(path, "hello\nworld\n");
    const r = readLogTail(path, 4096);
    expect(r.text).toBe("hello\nworld\n");
    expect(r.size).toBe(12);
    expect(r.truncated).toBe(false);
  });

  it("clips the front when the file exceeds maxBytes", () => {
    const path = join(dir, "big.log");
    const big = "X".repeat(10_000) + "END";
    writeFileSync(path, big);
    const r = readLogTail(path, 8);
    expect(r.text).toBe("XXXXXEND");
    expect(r.size).toBe(10_003);
    expect(r.truncated).toBe(true);
  });

  it("throws when the file is missing", () => {
    expect(() => readLogTail(join(dir, "missing.log"))).toThrow(/ENOENT/);
  });
});
