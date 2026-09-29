import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./load-config.js";
import { resetConfigCache } from "./config-cache.js";

/**
 * The external llama-server URL comes from `localModels.url` only; there
 * is no env override. Issue #535: hints kept telling users to set
 * `ATOMIC_AGENT_LLAMA_URL`, which did nothing. These assertions pin the
 * behaviour and keep the dead variable out of user-facing text.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEAD_ENV = "ATOMIC_AGENT_LLAMA_URL";

describe("ATOMIC_AGENT_LLAMA_URL", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-llama-url-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    resetConfigCache();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    delete process.env[DEAD_ENV];
    resetConfigCache();
    vi.restoreAllMocks();
  });

  it("is not read: the URL resolves from localModels.url", () => {
    process.env[DEAD_ENV] = "http://127.0.0.1:9999";
    expect(loadConfig().localModels.url).toBe("http://127.0.0.1:8080");
  });

  it.each([
    "src/sidecar/main.ts",
    "scripts/package-bundle.ts",
    "BUNDLING.md",
    "AGENTS.md",
    "README.md",
  ])("is not suggested by %s", (relative) => {
    expect(readFileSync(resolve(repoRoot, relative), "utf8")).not.toContain(
      DEAD_ENV,
    );
  });
});
