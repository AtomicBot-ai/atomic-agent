import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  IntegrationSecretError,
  displayFieldValue,
  presentFieldKeys,
  readConfigPath,
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

describe("config-backed fields", () => {
  const OWNER_FIELD: IntegrationField = {
    key: "ownerUserId",
    label: "Owner user ID",
    store: "config",
    configPath: "discord.ownerUserId",
    envVar: "",
    secret: false,
    required: true,
  };

  it("reads from the config object, not the env", () => {
    expect(
      readFieldValue(OWNER_FIELD, {}, { discord: { ownerUserId: "123" } }),
    ).toBe("123");
  });

  it("reads a numeric config value as a string", () => {
    // A hand-edited config may hold a number; the UI is string-shaped.
    expect(readFieldValue(OWNER_FIELD, {}, { discord: { ownerUserId: 7 } })).toBe(
      "7",
    );
  });

  it("reads an unset or null config value as absent", () => {
    expect(
      readFieldValue(OWNER_FIELD, {}, { discord: { ownerUserId: null } }),
    ).toBeUndefined();
    expect(readFieldValue(OWNER_FIELD, {}, {})).toBeUndefined();
  });

  it("counts a config-backed field as present", () => {
    const descriptor: IntegrationDescriptor = {
      ...DESCRIPTOR,
      fields: [OWNER_FIELD],
    };
    const present = presentFieldKeys(descriptor, {}, {
      discord: { ownerUserId: "123" },
    });
    expect([...present]).toEqual(["ownerUserId"]);
  });

  it("refuses to write without a config path", () => {
    // Failing loudly beats silently writing the value nowhere.
    expect(() =>
      writeFieldValue(stateDir, OWNER_FIELD, "123", {}, undefined),
    ).toThrow(/config path/);
  });

  it("still runs the field's validator before writing", () => {
    const guarded: IntegrationField = {
      ...OWNER_FIELD,
      validate: () => "nope",
    };
    expect(() =>
      writeFieldValue(stateDir, guarded, "123", {}, "/tmp/x.json"),
    ).toThrow(/nope/);
  });
});

describe("list fields", () => {
  const OWNERS_FIELD: IntegrationField = {
    key: "ownerUserIds",
    label: "Owner user IDs",
    store: "config",
    kind: "list",
    configPath: "discord.ownerUserIds",
    envVar: "",
    secret: false,
    required: true,
    validate: (raw) =>
      /^\d{15,25}$/.test(raw) ? undefined : "not an id",
  };

  it("renders the stored list as one comma-separated line", () => {
    expect(
      readFieldValue(OWNERS_FIELD, {}, {
        discord: { ownerUserIds: ["123456789012345678", "223456789012345678"] },
      }),
    ).toBe("123456789012345678, 223456789012345678");
  });

  it("reads an empty or missing list as absent, so `required` still bites", () => {
    expect(
      readFieldValue(OWNERS_FIELD, {}, { discord: { ownerUserIds: [] } }),
    ).toBeUndefined();
    expect(readFieldValue(OWNERS_FIELD, {}, {})).toBeUndefined();
  });

  it("splits, trims and dedupes what the operator typed", () => {
    const file = join(stateDir, "config.json");
    writeFieldValue(
      stateDir,
      OWNERS_FIELD,
      " 123456789012345678 ,223456789012345678, ,123456789012345678 ",
      {},
      file,
    );
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as {
      discord: { ownerUserIds: string[] };
    };
    expect(onDisk.discord.ownerUserIds).toEqual([
      "123456789012345678",
      "223456789012345678",
    ]);
  });

  it("validates each entry and names the one that is wrong", () => {
    // A single-id validator run over the joined line would reject every
    // multi-entry value, so the per-entry pass is the contract.
    expect(() =>
      writeFieldValue(
        stateDir,
        OWNERS_FIELD,
        "123456789012345678, nope",
        {},
        join(stateDir, "config.json"),
      ),
    ).toThrow(/nope: not an id/);
  });

  it("refuses a line with nothing in it", () => {
    expect(() =>
      writeFieldValue(
        stateDir,
        OWNERS_FIELD,
        " , , ",
        {},
        join(stateDir, "config.json"),
      ),
    ).toThrow(/empty/);
  });

  it("clears to an empty list", () => {
    const file = join(stateDir, "config.json");
    writeFieldValue(stateDir, OWNERS_FIELD, "123456789012345678", {}, file);
    writeFieldValue(stateDir, OWNERS_FIELD, null, {}, file);
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as {
      discord: { ownerUserIds: string[] };
    };
    expect(onDisk.discord.ownerUserIds).toEqual([]);
  });
});

describe("readConfigPath", () => {
  it("walks a dotted path", () => {
    expect(readConfigPath({ a: { b: { c: 1 } } }, "a.b.c")).toBe(1);
  });

  it("returns undefined at the first gap instead of throwing", () => {
    expect(readConfigPath({ a: {} }, "a.b.c")).toBeUndefined();
    expect(readConfigPath(undefined, "a")).toBeUndefined();
    expect(readConfigPath({ a: 1 }, "a.b")).toBeUndefined();
  });
});
