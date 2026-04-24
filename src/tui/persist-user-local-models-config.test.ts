import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetConfigCache } from "../config/config-cache.js";
import { getUserConfigPath, writeUserConfigFileSync } from "../config/config-file.js";
import { USER_CONFIG_DEFAULTS } from "../config/config-schema.js";
import { getConfig } from "../config/index.js";
import {
  normalizeLocalLlmBaseUrl,
  persistUserLocalLlmUrl,
} from "./persist-user-local-models-config.js";

describe("normalizeLocalLlmBaseUrl", () => {
  it("adds http when scheme is missing", () => {
    expect(normalizeLocalLlmBaseUrl("127.0.0.1:9000")).toBe("http://127.0.0.1:9000");
  });

  it("preserves https", () => {
    expect(normalizeLocalLlmBaseUrl("https://example.com/v1/")).toBe(
      "https://example.com/v1/",
    );
  });

  it("rejects empty input", () => {
    expect(() => normalizeLocalLlmBaseUrl("  ")).toThrow("empty");
  });
});

describe("persistUserLocalLlmUrl", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-local-llm-persist-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    resetConfigCache();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
    vi.restoreAllMocks();
  });

  it("updates localModels.url in the user config file and refreshes the cache", () => {
    const path = getUserConfigPath(stateDir);
    writeUserConfigFileSync(path, USER_CONFIG_DEFAULTS);
    resetConfigCache();
    persistUserLocalLlmUrl("http://192.168.1.5:7777");
    const written = JSON.parse(readFileSync(path, "utf8")) as {
      localModels: { url: string; mode: string };
    };
    expect(written.localModels.url).toBe("http://192.168.1.5:7777");
    expect(written.localModels.mode).toBe("external");
    expect(getConfig().localModels.url).toBe("http://192.168.1.5:7777");
  });
});
