import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { USER_CONFIG_DEFAULTS, USER_CONFIG_VERSION } from "../config/index.js";

import { startTestHarness, type Harness } from "./test-harness.js";

const PROVIDERS = [
  { id: "openrouter", kind: "openrouter", apiKey: "k" },
  { id: "local-llama", kind: "llama-server", baseUrl: "http://127.0.0.1:8080" },
];

/**
 * A config a user has actually customised: cloud providers, an MCP
 * server, a hidden skill and an analytics opt-out. Every one of these
 * used to be reset by a PATCH that named none of them (#544).
 */
function customisedConfig(): Record<string, unknown> {
  return {
    ...USER_CONFIG_DEFAULTS,
    llm: {
      activeTextProvider: "openrouter",
      providers: PROVIDERS,
    },
    mcp: {
      ...USER_CONFIG_DEFAULTS.mcp,
      servers: [
        {
          name: "github",
          enabled: true,
          transport: { kind: "stdio", command: "npx", args: ["-y", "mcp"] },
        },
      ],
    },
    skills: { ...USER_CONFIG_DEFAULTS.skills, disabled: ["noisy-skill"] },
    analytics: { ...USER_CONFIG_DEFAULTS.analytics, enabled: false },
  };
}

describe("PATCH /api/config", () => {
  let harness: Harness;
  let configPath: string;

  beforeEach(async () => {
    harness = await startTestHarness();
    configPath = join(harness.stateDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify(customisedConfig(), null, 2),
      "utf8",
    );
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  async function patch(body: unknown): Promise<Response> {
    return fetch(`${harness.baseUrl}/api/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function onDisk(): Record<string, any> {
    return JSON.parse(readFileSync(configPath, "utf8"));
  }

  it("keeps every block the patch does not name", async () => {
    const response = await patch({ log: { level: "debug" } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { config: Record<string, any> };

    for (const config of [body.config, onDisk()]) {
      expect(config.log.level).toBe("debug");
      expect(config.llm.activeTextProvider).toBe("openrouter");
      expect(config.llm.providers).toEqual(PROVIDERS);
      expect(config.mcp.servers.map((s: { name: string }) => s.name)).toEqual([
        "github",
      ]);
      expect(config.skills.disabled).toEqual(["noisy-skill"]);
      expect(config.analytics.enabled).toBe(false);
    }
  });

  it("merges nested objects key by key and replaces arrays", async () => {
    const response = await patch({
      log: { level: "debug" },
      skills: { disabled: ["other-skill"] },
    });
    expect(response.status).toBe(200);
    const config = onDisk();
    expect(config.skills.disabled).toEqual(["other-skill"]);
    // A sibling of the patched key inside the same block survives.
    expect(config.skills.taps).toEqual(USER_CONFIG_DEFAULTS.skills.taps);
    expect(config.log).toEqual({ ...USER_CONFIG_DEFAULTS.log, level: "debug" });
  });

  it("ignores a version in the patch", async () => {
    const response = await patch({
      version: USER_CONFIG_VERSION + 5,
      log: { level: "debug" },
    });
    expect(response.status).toBe(200);
    expect(onDisk().version).toBe(USER_CONFIG_VERSION);
  });

  it("rejects an invalid value and leaves the file untouched", async () => {
    const before = readFileSync(configPath, "utf8");
    const response = await patch({ log: { level: "shouting" } });
    expect(response.status).toBe(400);
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  it("rejects a body that is not a JSON object", async () => {
    const before = readFileSync(configPath, "utf8");
    const response = await patch([{ log: { level: "debug" } }]);
    expect(response.status).toBe(400);
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  it("refuses a __proto__ key instead of walking it", async () => {
    const before = readFileSync(configPath, "utf8");
    const response = await fetch(`${harness.baseUrl}/api/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: '{"log":{"__proto__":{"polluted":true}}}',
    });
    expect(response.status).toBe(400);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });
});
