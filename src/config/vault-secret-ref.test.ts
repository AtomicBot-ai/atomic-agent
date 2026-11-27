import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resetResolvedSecretValues, resolvedSecretValues } from "../sandbox/resolved-secret-values.js";
import { resetSecretRefCache, resolveSecretRef, resolveSecretRefSync } from "./secret-ref-resolver.js";
import { EMPTY_SECRET_SOURCES } from "./secret-refs.js";
import {
  fetchVault,
  fetchVaultSync,
  planVaultRequest,
  readCappedText,
  vaultFieldOf,
  type VaultRequest,
  type VaultResponse,
} from "./vault-secret-ref.js";

// ATO-2530: Vault KV v2 over HTTP. The fetcher is faked; nothing talks to a server.
const VALUE = "Vault7Live8Secret9Value";
const REF = { mount: "secret", path: "apps/deploy", field: "token" };
const ENV: NodeJS.ProcessEnv = { VAULT_ADDR: "https://vault.example.com:8200", VAULT_TOKEN: "hvs.token-123" };

afterEach(() => {
  vi.unstubAllGlobals();
  resetSecretRefCache();
  resetResolvedSecretValues();
});

function ok(data: Record<string, unknown>): VaultResponse {
  return { status: 200, text: JSON.stringify({ data: { data, metadata: { version: 3 } } }) };
}

describe("planVaultRequest", () => {
  it("builds the KV v2 data URL with each part encoded and the token in a header", () => {
    const req = planVaultRequest({ mount: "secret", path: "my app/deploy", field: "token" }, { ...ENV, VAULT_NAMESPACE: "team" });
    if (typeof req === "string") throw new Error(req);
    expect(req.url).toBe("https://vault.example.com:8200/v1/secret/data/my%20app/deploy");
    expect(req.headers["X-Vault-Token"]).toBe("hvs.token-123");
    expect(req.headers["X-Vault-Namespace"]).toBe("team");
    expect(req.url).not.toContain("hvs.");
  });

  it("refuses plain http to another host, allows it to this computer", () => {
    expect(typeof planVaultRequest(REF, { ...ENV, VAULT_ADDR: "http://vault.example.com" })).toBe("string");
    expect(typeof planVaultRequest(REF, { ...ENV, VAULT_ADDR: "http://127.0.0.1:8200" })).toBe("object");
  });

  it("needs an address and a token, and falls back to ~/.vault-token", () => {
    const home = mkdtempSync(join(tmpdir(), "vault-home-"));
    try {
      expect(planVaultRequest(REF, { VAULT_TOKEN: "t" }, home)).toMatch(/VAULT_ADDR/);
      expect(planVaultRequest(REF, { VAULT_ADDR: ENV.VAULT_ADDR }, home)).toMatch(/VAULT_TOKEN/);
      writeFileSync(join(home, ".vault-token"), "hvs.from-file\n");
      const req = planVaultRequest(REF, { VAULT_ADDR: ENV.VAULT_ADDR }, home);
      if (typeof req === "string") throw new Error(req);
      expect(req.headers["X-Vault-Token"]).toBe("hvs.from-file");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("vaultFieldOf", () => {
  const req: VaultRequest = { url: "u", headers: {}, field: "token" };
  it("reads data.data[field] and explains every failure without a value", () => {
    expect(vaultFieldOf(ok({ token: VALUE }), req)).toEqual({ value: VALUE });
    expect(vaultFieldOf({ status: 403, text: "" }, req)).toEqual({ error: expect.stringMatching(/refused/) });
    expect(vaultFieldOf({ status: 404, text: "" }, req)).toEqual({ error: expect.stringMatching(/no secret/) });
    expect(vaultFieldOf(ok({ other: VALUE }), req)).toEqual({ error: "the secret has no field token" });
    expect(vaultFieldOf(ok({ token: 5 }), req)).toEqual({ error: "field token is not text" });
    expect(vaultFieldOf({ failure: "timeout" }, req)).toEqual({ error: expect.stringMatching(/in time/) });
  });
});

describe("resolving vault:// (sync and async)", () => {
  it("resolves the field, masks it and caches it", async () => {
    const seen: VaultRequest[] = [];
    const fetchVault = async (r: VaultRequest): Promise<VaultResponse> => {
      seen.push(r);
      return ok({ token: VALUE });
    };
    const deps = { sources: EMPTY_SECRET_SOURCES, env: ENV, fetchVault };
    expect(await resolveSecretRef("DEPLOY_TOKEN", "vault://secret/apps/deploy#token", deps)).toBe(VALUE);
    expect(await resolveSecretRef("DEPLOY_TOKEN", "vault://secret/apps/deploy#token", deps)).toBe(VALUE);
    expect(seen).toHaveLength(1);
    expect(resolvedSecretValues().some((v) => v.value === VALUE)).toBe(true);
  });

  it("fails with a message that names the variable, never the token or a value", () => {
    const fetchVault = (): VaultResponse => ({ status: 403, text: `{"errors":["${ENV.VAULT_TOKEN}"]}` });
    let message = "";
    try {
      resolveSecretRefSync("DEPLOY_TOKEN", "vault://secret/apps/deploy#token", {
        sources: EMPTY_SECRET_SOURCES,
        env: ENV,
        fetchVault,
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/^DEPLOY_TOKEN: Vault refused the token/);
    expect(message).not.toContain("hvs.");
  });
});

// Review round 1 (F2102.2): the 1 MiB cap stops the read, it is not a check
// after the whole body is in memory. Each body sends 2 MiB and never ends, so
// a reader that buffers first only returns at the deadline, as "timeout".
const MIB = 1024 * 1024;

function endlessBody(): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= 2 * MIB) return new Promise<void>(() => undefined);
      controller.enqueue(new Uint8Array(64 * 1024));
      sent += 64 * 1024;
      return undefined;
    },
  });
}

describe("the 1 MiB cap on a Vault answer", () => {
  it("readCappedText stops past the cap and reads a small body whole", async () => {
    expect(await readCappedText(endlessBody(), MIB)).toBeUndefined();
    expect(await readCappedText(new Response("hello").body, MIB)).toBe("hello");
    expect(await readCappedText(null, MIB)).toBe("");
  });

  it("fetchVault answers too-large before the deadline", async () => {
    vi.stubGlobal("fetch", async () => new Response(endlessBody(), { status: 200 }));
    const started = Date.now();
    const res = await fetchVault({ url: "https://vault.example.com/v1/x", headers: {}, field: "token" }, 60_000);
    expect(res).toEqual({ failure: "too-large" });
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it("the worker copy (sync .env path) also stops past the cap", async () => {
    // The server runs in a child process: fetchVaultSync blocks this thread.
    const server = spawn(
      process.execPath,
      [
        "-e",
        `const s = require("node:http").createServer((q, r) => {
           r.writeHead(200, { "content-type": "application/json" });
           const chunk = Buffer.alloc(64 * 1024, 120);
           for (let i = 0; i < 40; i++) r.write(chunk);
         });
         s.listen(0, "127.0.0.1", () => console.log(s.address().port));`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    try {
      const port = await new Promise<string>((resolve, reject) => {
        server.stdout.once("data", (d: Buffer) => resolve(d.toString().trim()));
        server.once("error", reject);
      });
      const res = fetchVaultSync({ url: `http://127.0.0.1:${port}/v1/x`, headers: {}, field: "token" }, 3_000);
      expect(res).toEqual({ failure: "too-large" });
    } finally {
      server.kill();
    }
  });
});
