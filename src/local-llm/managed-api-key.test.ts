import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveApiKeyFilePath } from "./backend-paths.js";
import {
  buildApiKeyArgs,
  ensureManagedApiKey,
  readManagedApiKey,
  resolveManagedServerAuth,
} from "./managed-api-key.js";

describe("managed llama-server api key (#582)", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "atomic-api-key-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("generates a key on first use and persists it next to the pid file", () => {
    expect(readManagedApiKey(dataDir)).toBeNull();
    const key = ensureManagedApiKey(dataDir);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    const path = resolveApiKeyFilePath(dataDir);
    expect(path).toBe(join(dataDir, "llama-server.key"));
    expect(readFileSync(path, "utf-8").trim()).toBe(key);
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  it("reuses the persisted key instead of generating a new one", () => {
    const first = ensureManagedApiKey(dataDir);
    const second = ensureManagedApiKey(dataDir);
    expect(second).toBe(first);
    expect(readManagedApiKey(dataDir)).toBe(first);
  });

  it("keeps a key written by another process", () => {
    writeFileSync(resolveApiKeyFilePath(dataDir), "other-process-key\n", "utf-8");
    expect(ensureManagedApiKey(dataDir)).toBe("other-process-key");
  });

  it("launches with the persisted key file when no key is configured", () => {
    const auth = resolveManagedServerAuth(dataDir, null);
    expect(auth.apiKey).toBe(readManagedApiKey(dataDir));
    expect(auth.apiKeyFile).toBe(resolveApiKeyFilePath(dataDir));
    expect(buildApiKeyArgs(auth)).toEqual([
      "--api-key-file",
      resolveApiKeyFilePath(dataDir),
    ]);
  });

  it("uses the file when the configured key is the persisted one", () => {
    const key = ensureManagedApiKey(dataDir);
    expect(resolveManagedServerAuth(dataDir, key)).toEqual({
      apiKey: key,
      apiKeyFile: resolveApiKeyFilePath(dataDir),
    });
  });

  it("a key the operator set wins and is passed as --api-key", () => {
    ensureManagedApiKey(dataDir);
    const auth = resolveManagedServerAuth(dataDir, "user-key");
    expect(auth).toEqual({ apiKey: "user-key" });
    expect(buildApiKeyArgs(auth)).toEqual(["--api-key", "user-key"]);
  });

  it("emits no flag when there is no key", () => {
    expect(buildApiKeyArgs(undefined)).toEqual([]);
    expect(buildApiKeyArgs({ apiKey: null })).toEqual([]);
  });
});
