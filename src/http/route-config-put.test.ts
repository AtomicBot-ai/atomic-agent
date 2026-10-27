import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { USER_CONFIG_DEFAULTS, USER_CONFIG_VERSION } from "../config/index.js";

import { startTestHarness, type Harness } from "./test-harness.js";

/** ATO-1022: the desktop's whole-file read and write, over HTTP instead of an `atag config` process each. */
describe("GET + PUT /api/config", () => {
  let harness: Harness;
  let configPath: string;

  beforeEach(async () => {
    harness = await startTestHarness();
    configPath = join(harness.stateDir, "config.json");
    writeFileSync(configPath, JSON.stringify(USER_CONFIG_DEFAULTS, null, 2), "utf8");
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  const sha = () => createHash("sha256").update(readFileSync(configPath)).digest("hex");

  async function get(): Promise<{ sha256: string; config: Record<string, any> }> {
    const response = await fetch(`${harness.baseUrl}/api/config`);
    expect(response.status).toBe(200);
    return (await response.json()) as { sha256: string; config: Record<string, any> };
  }

  function put(body: unknown): Promise<Response> {
    return fetch(`${harness.baseUrl}/api/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("GET carries the hash of the bytes it read", async () => {
    const read = await get();
    expect(read.sha256).toBe(sha());
    expect(read.config.version).toBe(USER_CONFIG_VERSION);
  });

  it("writes the whole file against the hash it was read with", async () => {
    const read = await get();
    const response = await put({
      config: { ...read.config, log: { ...read.config.log, level: "debug" } },
      expectSha256: read.sha256,
    });
    expect(response.status).toBe(200);
    expect((await response.json()) as { sha256: string }).toMatchObject({ sha256: sha() });
    expect(JSON.parse(readFileSync(configPath, "utf8")).log.level).toBe("debug");
  });

  it("refuses with 409 when the file moved since the read, and writes nothing", async () => {
    const read = await get();
    writeFileSync(
      configPath,
      JSON.stringify({ ...USER_CONFIG_DEFAULTS, log: { ...USER_CONFIG_DEFAULTS.log, level: "warn" } }, null, 2),
      "utf8",
    );
    const before = readFileSync(configPath, "utf8");
    const response = await put({ config: read.config, expectSha256: read.sha256 });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("config_changed");
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  it("writes without a hash when none is given", async () => {
    const read = await get();
    const response = await put({ config: { ...read.config, log: { ...read.config.log, level: "error" } } });
    expect(response.status).toBe(200);
    expect(JSON.parse(readFileSync(configPath, "utf8")).log.level).toBe("error");
  });

  it("validates before writing", async () => {
    const before = readFileSync(configPath, "utf8");
    const read = await get();
    expect((await put({ config: { ...read.config, log: { level: "shouting" } } })).status).toBe(400);
    expect((await put({ config: { ...read.config, version: USER_CONFIG_VERSION + 5 } })).status).toBe(400);
    expect((await put({ config: [] })).status).toBe(400);
    expect((await put({ config: read.config, expectSha256: "nope" })).status).toBe(400);
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });
});
