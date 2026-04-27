import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  USER_CONFIG_VERSION,
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
    expect(readFileSync(path, "utf8")).toContain("\"localModels\"");
    expect(warn).toHaveBeenCalledOnce();

    const second = ensureUserConfigFileSync(path);
    expect(second).toEqual(USER_CONFIG_DEFAULTS);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("ensureUserConfigFileSync migrates v5 → v6 on disk and preserves user values", () => {
    const path = getUserConfigPath(dir);
    const v5 = {
      version: 5,
      localModels: {
        url: "http://127.0.0.1:9999",
        mode: "managed",
        managed: {
          modelId: "qwen-3.5-4b",
          port: 19091,
          dataDirOverride: null,
          autoUpdate: false,
        },
      },
      log: { level: "debug" },
      agent: USER_CONFIG_DEFAULTS.agent,
      http: USER_CONFIG_DEFAULTS.http,
      tracing: USER_CONFIG_DEFAULTS.tracing,
      memory: USER_CONFIG_DEFAULTS.memory,
      webhooks: {},
    };
    writeFileSync(path, JSON.stringify(v5, null, 2) + "\n", "utf8");

    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const migrated = ensureUserConfigFileSync(path);

    expect(migrated.version).toBe(USER_CONFIG_VERSION);
    expect(migrated.localModels.url).toBe("http://127.0.0.1:9999");
    expect(migrated.log.level).toBe("debug");
    expect(migrated.vision).toEqual(USER_CONFIG_DEFAULTS.vision);

    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.version).toBe(USER_CONFIG_VERSION);
    expect(onDisk.vision).toEqual(USER_CONFIG_DEFAULTS.vision);
    expect(onDisk.localModels.url).toBe("http://127.0.0.1:9999");

    const calls = warn.mock.calls.map((args) => String(args[0]));
    expect(calls.some((line) => line.includes("migrated config v5 → v6"))).toBe(true);
    warn.mockRestore();
  });

  it("ensureUserConfigFileSync leaves an up-to-date file untouched on disk", () => {
    const path = getUserConfigPath(dir);
    writeUserConfigFileSync(path, USER_CONFIG_DEFAULTS);
    const before = statSync(path).mtimeMs;

    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = ensureUserConfigFileSync(path);
    expect(result).toEqual(USER_CONFIG_DEFAULTS);
    expect(warn).not.toHaveBeenCalled();
    expect(statSync(path).mtimeMs).toBe(before);
    warn.mockRestore();
  });
});
