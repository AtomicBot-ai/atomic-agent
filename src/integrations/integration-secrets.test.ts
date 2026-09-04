import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  IntegrationSecretError,
  displayFieldValue,
  presentFieldKeys,
  readFieldValue,
  writeFieldValue,
} from "./integration-secrets.js";
import type {
  IntegrationDescriptor,
  IntegrationField,
} from "./integration-descriptor.js";

const KEY_FIELD: IntegrationField = {
  key: "apiKey",
  label: "API key",
  envVar: "TEST_INTEGRATION_KEY",
  secret: true,
  required: true,
  validate: (raw) => (raw.startsWith("ok_") ? undefined : "must start with ok_"),
};

const PLAIN_FIELD: IntegrationField = {
  key: "endpoint",
  label: "Endpoint",
  envVar: "TEST_INTEGRATION_ENDPOINT",
  secret: false,
  required: false,
};

const DESCRIPTOR: IntegrationDescriptor = {
  id: "test",
  label: "Test",
  summary: "",
  appliesLive: true,
  fields: [KEY_FIELD, PLAIN_FIELD],
  status: () => ({ level: "not_configured" }),
};

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "integration-secrets-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("readFieldValue", () => {
  it("trims and returns a set value", () => {
    expect(readFieldValue(KEY_FIELD, { TEST_INTEGRATION_KEY: " ok_1 " })).toBe(
      "ok_1",
    );
  });

  it("reads an unset or blank value as absent", () => {
    expect(readFieldValue(KEY_FIELD, {})).toBeUndefined();
    expect(readFieldValue(KEY_FIELD, { TEST_INTEGRATION_KEY: "  " })).toBeUndefined();
  });
});

describe("presentFieldKeys", () => {
  it("reports only the fields that hold a value", () => {
    const present = presentFieldKeys(DESCRIPTOR, {
      TEST_INTEGRATION_KEY: "ok_1",
    });
    expect([...present]).toEqual(["apiKey"]);
  });
});

describe("displayFieldValue", () => {
  it("masks a secret so a screen-share never leaks it", () => {
    const shown = displayFieldValue(KEY_FIELD, "ok_supersecret");
    expect(shown).toBe("•".repeat("ok_supersecret".length));
    expect(shown).not.toContain("supersecret");
  });

  it("caps the mask so a long key cannot blow out the pane", () => {
    const shown = displayFieldValue(KEY_FIELD, "x".repeat(100));
    expect(shown).toBe(`${"•".repeat(32)}+68`);
  });

  it("shows a non-secret value as-is and an unset value as a dash", () => {
    expect(displayFieldValue(PLAIN_FIELD, "https://x.test")).toBe(
      "https://x.test",
    );
    expect(displayFieldValue(PLAIN_FIELD, undefined)).toBe("—");
  });
});

describe("writeFieldValue", () => {
  it("writes to <stateDir>/.env and updates the live process env", () => {
    const env: NodeJS.ProcessEnv = {};
    writeFieldValue(stateDir, KEY_FIELD, "ok_live", env);
    expect(readFileSync(join(stateDir, ".env"), "utf8")).toContain(
      "TEST_INTEGRATION_KEY=ok_live",
    );
    // Without the in-process update, the hub would report the key saved
    // while every consumer still read the old value until a restart.
    expect(env.TEST_INTEGRATION_KEY).toBe("ok_live");
  });

  it("rejects a value the field's own validator refuses", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(() => writeFieldValue(stateDir, KEY_FIELD, "nope", env)).toThrow(
      IntegrationSecretError,
    );
    expect(env.TEST_INTEGRATION_KEY).toBeUndefined();
  });

  it("rejects an empty value rather than storing a blank key", () => {
    expect(() => writeFieldValue(stateDir, KEY_FIELD, "   ", {})).toThrow(
      /empty/,
    );
  });

  it("clears the key from both .env and the live env", () => {
    const env: NodeJS.ProcessEnv = {};
    writeFieldValue(stateDir, KEY_FIELD, "ok_live", env);
    writeFieldValue(stateDir, KEY_FIELD, null, env);
    // Dropping the last key removes the file outright, so read it back
    // defensively rather than assuming it survives.
    const envPath = join(stateDir, ".env");
    const onDisk = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
    expect(onDisk).not.toContain("ok_live");
    expect(env.TEST_INTEGRATION_KEY).toBeUndefined();
  });

  it("leaves a sibling key untouched when one is cleared", () => {
    // The .env is shared with every other secret in the install --
    // clearing a Composio key must not take TELEGRAM_BOT_TOKEN with it.
    const env: NodeJS.ProcessEnv = {};
    writeFieldValue(stateDir, KEY_FIELD, "ok_live", env);
    writeFieldValue(stateDir, PLAIN_FIELD, "https://x.test", env);
    writeFieldValue(stateDir, KEY_FIELD, null, env);
    const onDisk = readFileSync(join(stateDir, ".env"), "utf8");
    expect(onDisk).toContain("TEST_INTEGRATION_ENDPOINT=https://x.test");
    expect(onDisk).not.toContain("ok_live");
  });
});
