import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getUserConfigPath, writeUserConfigFileSync } from "./config-file.js";
import { writeRawUserConfigFileSync } from "./config-paths.js";
import { USER_CONFIG_DEFAULTS } from "./config-schema.js";
import {
  OWNER_ONLY_FILE_MODE,
  writeOwnerOnlyFileAtomicSync,
} from "./owner-only-file.js";

const posix = process.platform !== "win32";
const modeOf = (path: string): number => statSync(path).mode & 0o777;

describe("writeOwnerOnlyFileAtomicSync", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "owner-only-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the file with the payload, owner read/write only", () => {
    const path = join(dir, "config.json");
    writeOwnerOnlyFileAtomicSync(path, '{"a":1}\n');
    expect(readFileSync(path, "utf8")).toBe('{"a":1}\n');
    if (posix) expect(modeOf(path)).toBe(OWNER_ONLY_FILE_MODE);
  });

  it("tightens a file that other accounts could read", () => {
    const path = join(dir, "config.json");
    writeFileSync(path, "old\n", { mode: 0o644 });
    if (posix) {
      chmodSync(path, 0o644);
      expect(modeOf(path)).toBe(0o644);
    }
    writeOwnerOnlyFileAtomicSync(path, "new\n");
    expect(readFileSync(path, "utf8")).toBe("new\n");
    if (posix) expect(modeOf(path)).toBe(0o600);
  });

  it("leaves no tmp file behind", () => {
    const path = join(dir, "config.json");
    writeOwnerOnlyFileAtomicSync(path, "one\n");
    writeOwnerOnlyFileAtomicSync(path, "two\n");
    expect(readdirSync(dir)).toEqual(["config.json"]);
  });

  it("replaces a tmp file a crash left, without inheriting its mode", () => {
    const path = join(dir, "config.json");
    const leftover = `${path}.tmp-${process.pid}`;
    writeFileSync(leftover, "half a write", { mode: 0o644 });
    if (posix) chmodSync(leftover, 0o644);
    writeOwnerOnlyFileAtomicSync(path, "whole\n");
    expect(readFileSync(path, "utf8")).toBe("whole\n");
    expect(existsSync(leftover)).toBe(false);
    if (posix) expect(modeOf(path)).toBe(0o600);
  });

  it("throws and cleans up its tmp file when the rename cannot happen", () => {
    // A non-empty directory where the file should be: renameSync fails on
    // every platform, and nothing is left beside it.
    const path = join(dir, "taken");
    mkdirSync(join(path, "inside"), { recursive: true });
    expect(() => writeOwnerOnlyFileAtomicSync(path, "x")).toThrow();
    expect(existsSync(`${path}.tmp-${process.pid}`)).toBe(false);
    expect(existsSync(join(path, "inside"))).toBe(true);
  });
});

describe("config.json is written owner-only", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "owner-only-config-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writeUserConfigFileSync writes 0600 and tightens a 0644 file", () => {
    const path = getUserConfigPath(dir);
    writeFileSync(path, "{}\n", { mode: 0o644 });
    if (posix) chmodSync(path, 0o644);
    writeUserConfigFileSync(path, USER_CONFIG_DEFAULTS);
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(
      USER_CONFIG_DEFAULTS.version,
    );
    if (posix) expect(modeOf(path)).toBe(0o600);
  });

  it("writeRawUserConfigFileSync writes 0600 and tightens a 0644 file", () => {
    const path = getUserConfigPath(dir);
    writeFileSync(path, "{}\n", { mode: 0o644 });
    if (posix) chmodSync(path, 0o644);
    writeRawUserConfigFileSync(path, { version: 1, log: { level: "info" } });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      version: 1,
      log: { level: "info" },
    });
    if (posix) expect(modeOf(path)).toBe(0o600);
  });

  it("a config written into a fresh directory is 0600 too", () => {
    const path = join(dir, "nested", "config.json");
    writeUserConfigFileSync(path, USER_CONFIG_DEFAULTS);
    if (posix) expect(modeOf(path)).toBe(0o600);
  });
});
