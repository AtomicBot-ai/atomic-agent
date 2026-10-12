import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveApiKeyFilePath } from "../backend-paths.js";
import {
  apiKeyForUrl,
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

  it.each([
    ["empty", ""],
    ["whitespace-only", "  \n\t\n"],
    ["unusable (comma)", "a,b\n"],
  ])("replaces an %s key file with a fresh key", (_label, contents) => {
    const path = resolveApiKeyFilePath(dataDir);
    writeFileSync(path, contents, "utf-8");
    const key = ensureManagedApiKey(dataDir);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(path, "utf-8").trim()).toBe(key);
    expect(readManagedApiKey(dataDir)).toBe(key);
    expect(ensureManagedApiKey(dataDir)).toBe(key);
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  it("releases the heal lock and leaves no temp files behind", () => {
    writeFileSync(resolveApiKeyFilePath(dataDir), "", "utf-8");
    expect(ensureManagedApiKey(dataDir)).toMatch(/^[0-9a-f]{64}$/);
    expect(readdirSync(dataDir)).toEqual(["llama-server.key"]);
  });

  it("heals past a heal lock left by a process that died holding it", () => {
    const path = resolveApiKeyFilePath(dataDir);
    writeFileSync(path, "", "utf-8");
    const lock = `${path}.heal-lock`;
    writeFileSync(lock, "999999\n", "utf-8");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const key = ensureManagedApiKey(dataDir);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(path, "utf-8").trim()).toBe(key);
    expect(existsSync(lock)).toBe(false);
  });

  it("heals at once past a fresh heal lock whose holder has exited", () => {
    const path = resolveApiKeyFilePath(dataDir);
    writeFileSync(path, "", "utf-8");
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    const lock = `${path}.heal-lock`;
    writeFileSync(lock, `${deadPid} 0123456789abcdef\n`, "utf-8");
    const started = Date.now();
    const key = ensureManagedApiKey(dataDir);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(path, "utf-8").trim()).toBe(key);
    expect(readdirSync(dataDir)).toEqual(["llama-server.key"]);
  });

  it("takes over a heal lock whose creator never wrote its pid", () => {
    const path = resolveApiKeyFilePath(dataDir);
    writeFileSync(path, "", "utf-8");
    const lock = `${path}.heal-lock`;
    writeFileSync(lock, "", "utf-8");
    const created = new Date(Date.now() - 3_000);
    utimesSync(lock, created, created);
    const started = Date.now();
    const key = ensureManagedApiKey(dataDir);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(path, "utf-8").trim()).toBe(key);
    expect(readdirSync(dataDir)).toEqual(["llama-server.key"]);
  });

  it("clears a break guard left without a lock by a process that died breaking it", () => {
    const path = resolveApiKeyFilePath(dataDir);
    writeFileSync(path, "", "utf-8");
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(`${path}.heal-lock.break`, `${deadPid} fedcba9876543210\n`, "utf-8");
    const key = ensureManagedApiKey(dataDir);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(readdirSync(dataDir)).toEqual(["llama-server.key"]);
  });

  it("clears a break guard left by a process that died while breaking a lock", () => {
    const path = resolveApiKeyFilePath(dataDir);
    writeFileSync(path, "", "utf-8");
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(`${path}.heal-lock`, `${deadPid} 0123456789abcdef\n`, "utf-8");
    writeFileSync(`${path}.heal-lock.break`, `${deadPid} fedcba9876543210\n`, "utf-8");
    const key = ensureManagedApiKey(dataDir);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(path, "utf-8").trim()).toBe(key);
    expect(readdirSync(dataDir)).toEqual(["llama-server.key"]);
  });

  it("waits for a live lock holder and returns the key it writes", () => {
    const path = resolveApiKeyFilePath(dataDir);
    const lock = `${path}.heal-lock`;
    writeFileSync(path, "", "utf-8");
    // A holder in another process: it writes its key after 400ms, then
    // releases the lock. This process blocks meanwhile, so it must be a child.
    const holder = spawn(process.execPath, [
      "-e",
      `const fs = require("node:fs");
       setTimeout(() => {
         fs.writeFileSync(${JSON.stringify(`${path}.holder`)}, "holder-key\\n");
         fs.renameSync(${JSON.stringify(`${path}.holder`)}, ${JSON.stringify(path)});
         fs.unlinkSync(${JSON.stringify(lock)});
       }, 400);`,
    ]);
    try {
      writeFileSync(lock, `${holder.pid} 0123456789abcdef\n`, "utf-8");
      const started = Date.now();
      expect(ensureManagedApiKey(dataDir)).toBe("holder-key");
      expect(Date.now() - started).toBeGreaterThanOrEqual(200);
      expect(readFileSync(path, "utf-8")).toBe("holder-key\n");
    } finally {
      holder.kill();
    }
  });

  it("never takes or removes a live holder's lock, and gives up after a bounded wait", () => {
    const path = resolveApiKeyFilePath(dataDir);
    const lock = `${path}.heal-lock`;
    writeFileSync(path, "", "utf-8");
    const contents = `${process.pid} 0123456789abcdef\n`;
    writeFileSync(lock, contents, "utf-8");
    const started = Date.now();
    expect(ensureManagedApiKey(dataDir)).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(readFileSync(path, "utf-8")).toBe("");
    expect(readFileSync(lock, "utf-8")).toBe(contents);
    expect(readdirSync(dataDir).sort()).toEqual(["llama-server.key", "llama-server.key.heal-lock"]);
  }, 10_000);

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps a valid key it cannot read instead of replacing it",
    () => {
      const path = resolveApiKeyFilePath(dataDir);
      writeFileSync(path, "running-daemon-key\n", "utf-8");
      chmodSync(path, 0o000);
      expect(ensureManagedApiKey(dataDir)).toBe("running-daemon-key");
      expect(readFileSync(path, "utf-8")).toBe("running-daemon-key\n");
      expect(statSync(path).mode & 0o777).toBe(0o600);
    },
  );

  it("never overwrites a key file that stays unreadable", () => {
    const path = resolveApiKeyFilePath(dataDir);
    mkdirSync(path);
    expect(ensureManagedApiKey(dataDir)).toBeNull();
    expect(statSync(path).isDirectory()).toBe(true);
    expect(readdirSync(dataDir)).toEqual(["llama-server.key"]);
  });

  it("config and daemon launch agree on the healed key", () => {
    writeFileSync(resolveApiKeyFilePath(dataDir), "", "utf-8");
    const configKey = resolveLocalLlamaApiKey({
      envKey: undefined,
      mode: "managed",
      chatUrl: "http://127.0.0.1:19091",
      managedPorts: [19091, 19092],
      dataDir,
    });
    expect(configKey).toMatch(/^[0-9a-f]{64}$/);
    expect(resolveManagedServerApiKey(dataDir, null)).toBe(configKey);
  });

  it("leaves an unusable key file alone when the operator's env key is set", () => {
    const path = resolveApiKeyFilePath(dataDir);
    writeFileSync(path, "", "utf-8");
    expect(
      resolveLocalLlamaApiKey({
        envKey: "operator-key",
        mode: "managed",
        chatUrl: "http://127.0.0.1:19091",
        managedPorts: [19091, 19092],
        dataDir,
      }),
    ).toBe("operator-key");
    expect(readFileSync(path, "utf-8")).toBe("");
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

  describe("apiKeyForUrl", () => {
    function config(apiKey: string | null, url = "http://127.0.0.1:19091") {
      return {
        localModels: {
          url,
          apiKey,
          managed: { port: 19091 },
          embeddings: { port: 19092 },
        },
        paths: { localModelsDataDir: dataDir },
      };
    }

    it("never sends the managed daemons' key to another host", () => {
      const key = ensureManagedApiKey(dataDir);
      expect(apiKeyForUrl("http://192.168.1.5:8080", config(key), {})).toBeNull();
      expect(apiKeyForUrl("http://192.168.1.5:19091", config(key), {})).toBeNull();
      expect(apiKeyForUrl("http://127.0.0.1:8080", config(key), {})).toBeNull();
    });

    it("sends the managed key to a managed port on loopback", () => {
      const key = ensureManagedApiKey(dataDir);
      expect(apiKeyForUrl("http://127.0.0.1:19091", config(key), {})).toBe(key);
      expect(apiKeyForUrl("http://localhost:19092/", config(key), {})).toBe(key);
      // External mode elsewhere: no configured key, the file still answers.
      expect(
        apiKeyForUrl("http://127.0.0.1:19091", config(null, "http://lan:8080"), {}),
      ).toBe(key);
    });

    it("keeps the operator's env key for any URL, as before", () => {
      ensureManagedApiKey(dataDir);
      const env = { ATOMIC_AGENT_LLAMA_API_KEY: "operator-key" };
      expect(apiKeyForUrl("http://192.168.1.5:8080", config("operator-key"), env)).toBe(
        "operator-key",
      );
      expect(apiKeyForUrl("http://127.0.0.1:19091", config("operator-key"), env)).toBe(
        "operator-key",
      );
    });

    it("uses the configured key for the configured URL", () => {
      expect(
        apiKeyForUrl("http://lan:8080/", config(null, "http://lan:8080"), {}),
      ).toBeNull();
      expect(apiKeyForUrl("http://127.0.0.1:19091", config("k"), {})).toBe("k");
    });
  });
});
