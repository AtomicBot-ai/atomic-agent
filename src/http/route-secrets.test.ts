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
    expect(await response.json()).toEqual({ store: "env", keychainKeys: [] });
  });

  it("GET lists the names the keychain holds, never values", async () => {
    writeFileSync(
      join(harness.stateDir, "secrets-store.json"),
      JSON.stringify({ store: "keychain", keychainKeys: ["OPENROUTER_API_KEY"] }),
    );
    const response = await fetch(`${harness.baseUrl}/api/secrets`);
    expect(await response.json()).toEqual({
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
