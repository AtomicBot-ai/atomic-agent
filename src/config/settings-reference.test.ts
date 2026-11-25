import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { listConfigLeaves } from "./config-paths.js";
import { USER_CONFIG_VERSION } from "./config-schema.js";
import { ENV_SETTINGS, type EnvSetting } from "./env-settings.js";
import { SETTINGS_DOCS } from "./settings-docs.generated.js";
import { listSettingsReference } from "./settings-reference-data.js";
import {
  buildSettingsReference,
  filterSettings,
  renderSettingsReferenceMarkdown,
  renderSettingsText,
} from "./settings-reference.js";

const REFERENCE_DOC = fileURLToPath(new URL("../../docs/user/settings-reference.md", import.meta.url));
const REGENERATE = "run `npx tsx scripts/gen-settings-reference.ts`";

describe("buildSettingsReference", () => {
  const leaves = [
    { key: "agent.maxSteps", defaultValue: 25, isArray: false },
    { key: "projects.roots", defaultValue: [], isArray: true },
    { key: "version", defaultValue: 79, isArray: false },
    { key: "browser.cdpUrl", defaultValue: null, isArray: false },
  ];
  const env: EnvSetting[] = [
    { name: "X_CDP", overrides: "browser.cdpUrl", default: null, description: "d" },
  ];

  it("joins defaults, extracted docs and env overrides", () => {
    const rows = buildSettingsReference(
      leaves,
      { "agent.maxSteps": { type: "number", description: "Steps in one leg." } },
      env,
    );
    expect(rows[0]).toEqual({
      key: "agent.maxSteps",
      type: "number",
      default: 25,
      description: "Steps in one leg.",
      envVar: null,
      settable: true,
    });
    expect(rows[3]?.envVar).toBe("X_CDP");
  });

  it("falls back to the default's type and an empty description", () => {
    const rows = buildSettingsReference(leaves, {}, []);
    expect(rows.map((row) => row.type)).toEqual(["number", "array", "number", "null"]);
    expect(rows.every((row) => row.description === "")).toBe(true);
  });

  it("marks lists and version as not settable with `config set <key> <value>`", () => {
    const rows = buildSettingsReference(leaves, {}, []);
    expect(rows.map((row) => row.settable)).toEqual([true, false, false, true]);
  });
});

describe("filterSettings", () => {
  const rows = buildSettingsReference(
    [
      { key: "memory.links.enabled", defaultValue: true, isArray: false },
      { key: "agent.toolTimeoutMs", defaultValue: 60_000, isArray: false },
    ],
    { "agent.toolTimeoutMs": { type: "number", description: "Budget of one tool call." } },
    [],
  );

  it("keeps everything for an empty query", () => {
    expect(filterSettings(rows, "  ")).toHaveLength(2);
  });

  it("needs every word, in key or description, case-insensitive", () => {
    expect(filterSettings(rows, "LINKS").map((row) => row.key)).toEqual(["memory.links.enabled"]);
    expect(filterSettings(rows, "tool budget").map((row) => row.key)).toEqual(["agent.toolTimeoutMs"]);
    expect(filterSettings(rows, "tool links")).toEqual([]);
  });
});

describe("renderSettingsText", () => {
  it("shows the current value next to the default only when they differ", () => {
    const rows = buildSettingsReference(
      [{ key: "agent.maxSteps", defaultValue: 25, isArray: false }],
      { "agent.maxSteps": { type: "number", description: "Steps." } },
      [],
    );
    expect(renderSettingsText(rows, new Map([["agent.maxSteps", "25"]]))).toBe(
      "agent.maxSteps = 25  [number]\n    Steps.",
    );
    expect(renderSettingsText(rows, new Map([["agent.maxSteps", "40"]]))).toContain(
      "agent.maxSteps = 40  (default 25)  [number]",
    );
  });
});

describe("the live settings reference", () => {
  it("has one row per config.json key, in schema order", () => {
    expect(listSettingsReference().map((row) => row.key)).toEqual(listConfigLeaves().map((leaf) => leaf.key));
  });

  it("has generated docs for exactly the keys the schema has", () => {
    // A new key, or a removed one, without regenerating fails here.
    expect(Object.keys(SETTINGS_DOCS), REGENERATE).toEqual(listConfigLeaves().map((leaf) => leaf.key));
  });

  it("covers the keys the issue names", () => {
    const keys = new Set(listSettingsReference().map((row) => row.key));
    for (const key of ["agent.tokenBudget", "agent.maxSteps", "agent.approvalLevel", "localModels.managed.stopOnExit"]) {
      expect(keys.has(key)).toBe(true);
    }
  });

  it("points every env override at a real key", () => {
    const keys = new Set(listConfigLeaves().map((leaf) => leaf.key));
    for (const setting of ENV_SETTINGS) {
      if (setting.overrides !== null) expect(keys.has(setting.overrides), setting.name).toBe(true);
    }
  });

  it("matches the checked-in docs/user/settings-reference.md", () => {
    const expected = renderSettingsReferenceMarkdown(listSettingsReference(), ENV_SETTINGS, USER_CONFIG_VERSION);
    expect(readFileSync(REFERENCE_DOC, "utf8"), REGENERATE).toBe(expected);
  });
});
