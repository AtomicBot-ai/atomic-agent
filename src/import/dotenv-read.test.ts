import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readDotenvValue, stripDotenvQuotes } from "./dotenv-read.js";

describe("readDotenvValue", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dotenv-read-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns undefined for a missing file or key", () => {
    expect(readDotenvValue(join(dir, "nope"), "K")).toBeUndefined();
    writeFileSync(join(dir, ".env"), "OTHER=x\n");
    expect(readDotenvValue(join(dir, ".env"), "K")).toBeUndefined();
  });

  it("reads a key, strips quotes, skips comments", () => {
    writeFileSync(
      join(dir, ".env"),
      ["# comment", "", "A=1", 'B="two words"', "C='three'", "BROKEN"].join("\n"),
    );
    const path = join(dir, ".env");
    expect(readDotenvValue(path, "A")).toBe("1");
    expect(readDotenvValue(path, "B")).toBe("two words");
    expect(readDotenvValue(path, "C")).toBe("three");
  });
});

describe("stripDotenvQuotes", () => {
  it("strips only one matching pair", () => {
    expect(stripDotenvQuotes('"x"')).toBe("x");
    expect(stripDotenvQuotes("'x'")).toBe("x");
    expect(stripDotenvQuotes('"x\'')).toBe('"x\'');
    expect(stripDotenvQuotes('""x""')).toBe('"x"');
  });
});
