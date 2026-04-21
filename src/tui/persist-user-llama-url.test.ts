import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetConfigCache } from "../config/config-cache.js";
import { getUserConfigPath, writeUserConfigFileSync } from "../config/config-file.js";
import { USER_CONFIG_DEFAULTS } from "../config/config-schema.js";
import { getConfig } from "../config/index.js";
import {
  normalizeLlamaBaseUrl,
  persistUserLlamaUrl,
} from "./persist-user-llama-url.js";

describe("normalizeLlamaBaseUrl", () => {
  it("adds http when scheme is missing", () => {
    expect(normalizeLlamaBaseUrl("127.0.0.1:9000")).toBe("http://127.0.0.1:9000");
  });

  it("preserves https", () => {
    expect(normalizeLlamaBaseUrl("https://example.com/v1/")).toBe(
      "https://example.com/v1/",
    );
  });

  it("rejects empty input", () => {
    expect(() => normalizeLlamaBaseUrl("  ")).toThrow("empty");
  });
});

describe("persistUserLlamaUrl", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-llama-persist-"));
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

  it("updates llama.url in the user config file and refreshes the cache", () => {
    const path = getUserConfigPath(stateDir);
    writeUserConfigFileSync(path, USER_CONFIG_DEFAULTS);
    resetConfigCache();
    persistUserLlamaUrl("http://192.168.1.5:7777");
    const written = JSON.parse(readFileSync(path, "utf8")) as { llama: { url: string } };
    expect(written.llama.url).toBe("http://192.168.1.5:7777");
    expect(getConfig().llama.url).toBe("http://192.168.1.5:7777");
  });
});
