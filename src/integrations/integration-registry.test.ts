import { describe, expect, it } from "vitest";

import { findIntegration, listIntegrations } from "./integration-registry.js";
import { isConfigured } from "./integration-descriptor.js";

describe("integration registry", () => {
  it("lists Composio", () => {
    expect(listIntegrations().map((i) => i.id)).toContain("composio");
  });

  it("gives every integration a unique id", () => {
    const ids = listIntegrations().map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every field a unique key and env var within its integration", () => {
    for (const integration of listIntegrations()) {
      const keys = integration.fields.map((f) => f.key);
      const envVars = integration.fields.map((f) => f.envVar);
      expect(new Set(keys).size).toBe(keys.length);
      expect(new Set(envVars).size).toBe(envVars.length);
    }
  });

  it("names an env var the dotenv writer will accept", () => {
    // setDotenvKey rejects anything outside /^[A-Z_][A-Z0-9_]*$/, and it
    // throws at save time -- i.e. in front of the operator.
    for (const integration of listIntegrations()) {
      for (const field of integration.fields) {
        expect(field.envVar).toMatch(/^[A-Z_][A-Z0-9_]*$/);
      }
    }
  });

  it("finds by id and returns undefined for an unknown one", () => {
    expect(findIntegration("composio")?.label).toBe("Composio");
    expect(findIntegration("nope")).toBeUndefined();
  });
});

describe("isConfigured", () => {
  it("is false when a required field is missing", () => {
    const composio = findIntegration("composio")!;
    expect(isConfigured(composio, new Set())).toBe(false);
    expect(isConfigured(composio, new Set(["apiKey"]))).toBe(true);
  });

  it("never reports an integration with no required fields as configured", () => {
    // Otherwise an untouched entry would badge itself ready to use.
    expect(
      isConfigured(
        {
          id: "x",
          label: "X",
          summary: "",
          appliesLive: true,
          fields: [],
          status: () => ({ level: "not_configured" }),
        },
        new Set(),
      ),
    ).toBe(false);
  });
});
