import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureUserConfigFileSync,
  getUserConfigPath,
  readUserConfigFileSync,
  writeUserConfigFileSync,
} from "./config-file.js";
import {
  ConfigValidationError,
  USER_CONFIG_DEFAULTS,
} from "./config-schema.js";

describe("user config file IO", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-config-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("getUserConfigPath joins stateDir with config.json", () => {
    expect(getUserConfigPath(dir)).toBe(join(dir, "config.json"));
  });

  it("readUserConfigFileSync returns null when the file is absent", () => {
    expect(readUserConfigFileSync(getUserConfigPath(dir))).toBeNull();
  });

  it("writeUserConfigFileSync persists a valid file that parses back", () => {
    const path = getUserConfigPath(dir);
    writeUserConfigFileSync(path, USER_CONFIG_DEFAULTS);
    const loaded = readUserConfigFileSync(path);
    expect(loaded).toEqual(USER_CONFIG_DEFAULTS);
    const raw = readFileSync(path, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("readUserConfigFileSync throws on invalid JSON", () => {
    const path = getUserConfigPath(dir);
    writeFileSync(path, "not-json", "utf8");
    expect(() => readUserConfigFileSync(path)).toThrow(ConfigValidationError);
  });

  it("ensureUserConfigFileSync creates defaults and warns once", () => {
    const path = getUserConfigPath(dir);
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const first = ensureUserConfigFileSync(path);
    expect(first).toEqual(USER_CONFIG_DEFAULTS);
    expect(readFileSync(path, "utf8")).toContain("\"llama\"");
    expect(warn).toHaveBeenCalledOnce();

    const second = ensureUserConfigFileSync(path);
    expect(second).toEqual(USER_CONFIG_DEFAULTS);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
