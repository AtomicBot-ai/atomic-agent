import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveApiKeyFilePath } from "./backend-paths.js";
import {
  buildDaemonEnv,
  ensureManagedApiKey,
  isLoopbackUrlOnPort,
  readManagedApiKey,
  resolveEmbeddingApiKey,
  resolveLocalLlamaApiKey,
  resolveManagedServerApiKey,
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
    expect(ensureManagedApiKey(dataDir)).toBe(first);
    expect(readManagedApiKey(dataDir)).toBe(first);
  });

  it("keeps a key written by another process", () => {
    writeFileSync(resolveApiKeyFilePath(dataDir), "other-process-key\n", "utf-8");
    expect(ensureManagedApiKey(dataDir)).toBe("other-process-key");
  });

  it("an empty key file is 'not written yet', not a key", () => {
    writeFileSync(resolveApiKeyFilePath(dataDir), "", "utf-8");
    expect(readManagedApiKey(dataDir)).toBeNull();
  });

  it("the server key is the configured one, else the persisted one", () => {
    expect(resolveManagedServerApiKey(dataDir, "user-key")).toBe("user-key");
    expect(existsSync(resolveApiKeyFilePath(dataDir))).toBe(false);
    const key = resolveManagedServerApiKey(dataDir, null);
    expect(key).toBe(readManagedApiKey(dataDir));
  });

  it("puts the key in the child's env only", () => {
    const base = { PATH: "/bin" } as NodeJS.ProcessEnv;
    const env = buildDaemonEnv("k", base);
    expect(env).toEqual({ PATH: "/bin", LLAMA_API_KEY: "k" });
    expect(base.LLAMA_API_KEY).toBeUndefined();
    expect(buildDaemonEnv(null, base)).toEqual({ PATH: "/bin" });
  });

  it("recognises loopback URLs on the managed ports", () => {
    const ports = [19091, 19092];
    expect(isLoopbackUrlOnPort("http://127.0.0.1:19091", ports)).toBe(true);
    expect(isLoopbackUrlOnPort("http://localhost:19092/", ports)).toBe(true);
    expect(isLoopbackUrlOnPort("http://[::1]:19091", ports)).toBe(true);
    expect(isLoopbackUrlOnPort("http://127.0.0.1:8080", ports)).toBe(false);
    expect(isLoopbackUrlOnPort("http://box.lan:19091", ports)).toBe(false);
    expect(isLoopbackUrlOnPort("not a url", ports)).toBe(false);
  });

  describe("resolveLocalLlamaApiKey", () => {
    const managedPorts = [19091, 19092];

    it("the operator's key wins in every mode", () => {
      for (const mode of ["managed", "external"] as const) {
        expect(
          resolveLocalLlamaApiKey({
            envKey: "operator-key",
            mode,
            chatUrl: "http://127.0.0.1:19091",
            managedPorts,
            dataDir,
          }),
        ).toBe("operator-key");
      }
    });

    it("managed mode: the persisted key", () => {
      const key = resolveLocalLlamaApiKey({
        envKey: undefined,
        mode: "managed",
        chatUrl: "http://127.0.0.1:19091",
        managedPorts,
        dataDir,
      });
      expect(key).toBe(readManagedApiKey(dataDir));
      expect(key).not.toBeNull();
    });

    it("external mode pointed at the managed daemon: the same key `models start` launches with", () => {
      const launchKey = resolveManagedServerApiKey(dataDir, null);
      expect(
        resolveLocalLlamaApiKey({
          envKey: undefined,
          mode: "external",
          chatUrl: "http://127.0.0.1:19091",
          managedPorts,
          dataDir,
        }),
      ).toBe(launchKey);
    });

    it("external mode anywhere else: no key, and no key file", () => {
      expect(
        resolveLocalLlamaApiKey({
          envKey: undefined,
          mode: "external",
          chatUrl: "http://127.0.0.1:8080",
          managedPorts,
          dataDir,
        }),
      ).toBeNull();
      expect(existsSync(resolveApiKeyFilePath(dataDir))).toBe(false);
    });
  });

  describe("resolveEmbeddingApiKey", () => {
    it("reads the persisted key for the managed embedding port when nothing is configured", () => {
      const key = ensureManagedApiKey(dataDir);
      expect(
        resolveEmbeddingApiKey({
          configuredKey: null,
          embeddingsUrl: "http://127.0.0.1:19092",
          managedPorts: [19091, 19092],
          dataDir,
        }),
      ).toBe(key);
      expect(
        resolveEmbeddingApiKey({
          configuredKey: null,
          embeddingsUrl: "http://embed.lan:19092",
          managedPorts: [19091, 19092],
          dataDir,
        }),
      ).toBeNull();
      expect(
        resolveEmbeddingApiKey({
          configuredKey: "operator-key",
          embeddingsUrl: "http://127.0.0.1:19092",
          managedPorts: [19091, 19092],
          dataDir,
        }),
      ).toBe("operator-key");
    });
  });
});
