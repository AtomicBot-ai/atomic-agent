import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createWebSearchDefaults } from "../config/web-config.js";
import {
  EXA_API_KEY_ENV,
  EXA_INTEGRATION_ID,
  EXA_KEY_FIELD,
  exaIntegration,
} from "./exa-integration.js";
import { findIntegration } from "./integration-registry.js";
import { writeFieldValue } from "./integration-secrets.js";

function ctx(present: string[]) {
  return {
    presentFields: new Set(present),
    configured: present.includes(EXA_KEY_FIELD),
  };
}

const keyField = exaIntegration.fields.find((f) => f.key === EXA_KEY_FIELD)!;

describe("exaIntegration", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "atag-exa-integration-"));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it("is listed in the hub", () => {
    expect(findIntegration(EXA_INTEGRATION_ID)).toBe(exaIntegration);
  });

  it("stores the key under the variable web search reads by default", () => {
    expect(keyField.envVar).toBe(EXA_API_KEY_ENV);
    expect(createWebSearchDefaults().exa.apiKeyEnv).toBe(EXA_API_KEY_ENV);
    expect(keyField.secret).toBe(true);
    expect(exaIntegration.appliesLive).toBe(true);
  });

  it("writes the key to <stateDir>/.env and into the live environment", async () => {
    const env: NodeJS.ProcessEnv = {};
    writeFieldValue(stateDir, keyField, "  exa-test-key-123  ", env);
    expect(env[EXA_API_KEY_ENV]).toBe("exa-test-key-123");
    expect(await readFile(join(stateDir, ".env"), "utf8")).toContain(
      "EXA_API_KEY=exa-test-key-123",
    );
    writeFieldValue(stateDir, keyField, null, env);
    expect(env[EXA_API_KEY_ENV]).toBeUndefined();
    expect(await readFile(join(stateDir, ".env"), "utf8")).not.toContain("EXA_API_KEY");
  });

  it("rejects a paste with spaces or non-ASCII characters", () => {
    expect(keyField.validate?.("abc def")).toMatch(/plain ASCII/);
    expect(keyField.validate?.("abc”def")).toMatch(/plain ASCII/);
    expect(keyField.validate?.("abc-DEF_123")).toBeUndefined();
  });

  it("reports the keyless tier until a key is saved", () => {
    expect(exaIntegration.status(ctx([]))).toEqual({
      level: "not_configured",
      detail: "no key, using the keyless free tier",
    });
    expect(exaIntegration.status(ctx([EXA_KEY_FIELD])).level).toBe("configured");
  });
});
