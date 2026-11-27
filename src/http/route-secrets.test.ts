import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startTestHarness, type Harness } from "./test-harness.js";

/**
 * ATO-1639: the desktop saves keys through the running agent, so they land
 * where the agent keeps keys. Default (.env) mode only: the keychain branch
 * of the same writer is src/config/secret-access.test.ts.
 */
describe("GET /api/secrets + PUT /api/secrets/{name}", () => {
  let harness: Harness;
  let envPath: string;
  const NAME = "ATOMIC_ROUTE_TEST_API_KEY";

  beforeEach(async () => {
    harness = await startTestHarness();
    envPath = join(harness.stateDir, ".env");
    delete process.env[NAME];
  });

  afterEach(async () => {
    delete process.env[NAME];
    await harness.cleanup();
  });

  function put(name: string, body: unknown): Promise<Response> {
    return fetch(`${harness.baseUrl}/api/secrets/${name}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("GET answers the store and names, .env by default", async () => {
    const response = await fetch(`${harness.baseUrl}/api/secrets`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ store: "env", keychainKeys: [], references: {} });
  });

  it("GET lists the names the keychain holds, never values", async () => {
    writeFileSync(
      join(harness.stateDir, "secrets-store.json"),
      JSON.stringify({ store: "keychain", keychainKeys: ["OPENROUTER_API_KEY"] }),
    );
    const response = await fetch(`${harness.baseUrl}/api/secrets`);
    // `references` reads the real keychain here, so only the names are pinned.
    expect(await response.json()).toMatchObject({
      store: "keychain",
      keychainKeys: ["OPENROUTER_API_KEY"],
    });
  });

  it("PUT saves the key and the running agent uses it at once", async () => {
    const response = await put(NAME, { value: " sk-1 " });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ name: NAME, store: "env" });
    expect(body).not.toContain("sk-1");
    expect(readFileSync(envPath, "utf8")).toBe(`${NAME}=sk-1\n`);
    expect(process.env[NAME]).toBe("sk-1");
  });

  it("PUT null removes it from the file and the environment", async () => {
    await put(NAME, { value: "sk-1" });
    const response = await put(NAME, { value: null });
    expect(response.status).toBe(200);
    expect(existsSync(envPath)).toBe(false);
    expect(process.env[NAME]).toBeUndefined();
  });

  it("treats a loopback caller from the cloudflared tunnel as remote (ATO-2308)", async () => {
    const tunnel = { "cf-connecting-ip": "203.0.113.60" };
    const get = await fetch(`${harness.baseUrl}/api/secrets`, { headers: tunnel });
    expect(get.status).toBe(403);
    expect(((await get.json()) as { error: { code: string } }).error.code).toBe("loopback_only");
    const putRes = await fetch(`${harness.baseUrl}/api/secrets/${NAME}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...tunnel },
      body: JSON.stringify({ value: "sk-tunnel" }),
    });
    expect(putRes.status).toBe(403);
    expect(existsSync(envPath)).toBe(false);
    expect(process.env[NAME]).toBeUndefined();
    // Plain loopback is still served.
    expect((await fetch(`${harness.baseUrl}/api/secrets`)).status).toBe(200);
  });

  // ATO-2530: where a key saved as a reference comes from, never its value.
  it("GET names the source of a key saved as a reference", async () => {
    writeFileSync(envPath, `${NAME}=op://Private/OpenRouter/credential\nPLAIN_API_KEY=sk-plain\n`);
    const body = await (await fetch(`${harness.baseUrl}/api/secrets`)).text();
    expect(JSON.parse(body).references).toEqual({ [NAME]: "1password" });
    expect(body).not.toContain("sk-plain");
  });

  // ATO-2530: a reference saved mid-session is resolved at once, not at the next start.
  it("PUT a reference puts its resolved value in the environment, never the reference", async () => {
    const value = "Resolved9Value8Live7";
    writeFileSync(
      join(harness.stateDir, "secret-sources.json"),
      JSON.stringify({ command: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(value)})`] }),
    );
    const response = await put(NAME, { value: "cmd://openrouter" });
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      name: NAME,
      store: "env",
      reference: { source: "command", resolved: true },
    });
    expect(body).not.toContain(value);
    expect(process.env[NAME]).toBe(value);
    // The file keeps the reference.
    expect(readFileSync(envPath, "utf8")).toBe(`${NAME}=cmd://openrouter\n`);
  });

  it("PUT a reference that cannot be read saves it, leaves the variable unset and says why", async () => {
    writeFileSync(
      join(harness.stateDir, "secret-sources.json"),
      JSON.stringify({ command: [process.execPath, "-e", "process.exit(3)"] }),
    );
    process.env[NAME] = "old-key";
    // Another key than above: resolved values are cached for the process.
    const response = await put(NAME, { value: "cmd://broken-helper" });
    const json = (await response.json()) as { reference: { resolved: boolean; error?: string } };
    expect(json.reference.resolved).toBe(false);
    expect(json.reference.error).toMatch(new RegExp(`^${NAME}: `));
    expect(process.env[NAME]).toBeUndefined();
  });

  it("refuses names that are not keys, bad values and bad bodies, and writes nothing", async () => {
    expect((await put("NODE_OPTIONS", { value: "--require /tmp/x.js" })).status).toBe(400);
    expect((await put("PATH", { value: "/tmp" })).status).toBe(400);
    expect((await put(NAME, { value: "sk-1\nPATH=/tmp" })).status).toBe(400);
    expect((await put(NAME, { value: 42 })).status).toBe(400);
    expect((await put(NAME, [])).status).toBe(400);
    expect(existsSync(envPath)).toBe(false);
    expect(process.env.NODE_OPTIONS ?? "").not.toContain("/tmp/x.js");
  });
});
