import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readModelsDirOverrideFromFile } from "./models-dir-override-file.js";

describe("readModelsDirOverrideFromFile (ATO-2503)", () => {
  let root: string;
  let file: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "atomic-override-file-"));
    file = join(root, "config.json");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const withKey = (value: unknown) =>
    writeFileSync(file, JSON.stringify({ localModels: { managed: { modelsDirOverride: value } } }));

  it("is null for a missing file, an absent key or an empty value", () => {
    expect(readModelsDirOverrideFromFile(file)).toBeNull();
    writeFileSync(file, "{}");
    expect(readModelsDirOverrideFromFile(file)).toBeNull();
    withKey("  ");
    expect(readModelsDirOverrideFromFile(file)).toBeNull();
  });

  it("returns an absolute folder and expands ~", () => {
    const usb = join(root, "USB", "models");
    withKey(usb);
    expect(readModelsDirOverrideFromFile(file)).toBe(usb);
    withKey("~/models");
    expect(readModelsDirOverrideFromFile(file, "/home/me")).toBe(resolve("/home/me", "models"));
  });

  it("throws on broken JSON so the caller keeps its folder", () => {
    writeFileSync(file, "{ half");
    expect(() => readModelsDirOverrideFromFile(file)).toThrow();
  });
});
