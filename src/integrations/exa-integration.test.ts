import { describe, expect, it } from "vitest";

import { createWebSearchDefaults } from "../config/web-config.js";
import { EXA_GET_KEY_URL } from "../tools/os/web-search/web-search-errors.js";
import { findIntegration } from "./integration-registry.js";
import {
  EXA_API_KEY_ENV,
  EXA_KEY_FIELD,
  exaIntegration,
} from "./exa-integration.js";

function ctx(present: string[]) {
  return {
    presentFields: new Set(present),
    configured: present.includes(EXA_KEY_FIELD),
  };
}

describe("exaIntegration (ATO-345)", () => {
  it("is listed in the hub as Web search (Exa)", () => {
    expect(findIntegration("exa")?.label).toBe("Web search (Exa)");
  });

  it("stores one secret key under the env var web search reads by default", () => {
    const required = exaIntegration.fields.filter((f) => f.required);
    expect(required).toHaveLength(1);
    expect(required[0]?.envVar).toBe(EXA_API_KEY_ENV);
    expect(required[0]?.secret).toBe(true);
    // The row and the provider must agree, or a saved key is never used.
    expect(createWebSearchDefaults().exa.apiKeyEnv).toBe(EXA_API_KEY_ENV);
  });

  it("links where the key is issued and applies without a restart", () => {
    expect(exaIntegration.docsUrl).toBe(EXA_GET_KEY_URL);
    expect(exaIntegration.appliesLive).toBe(true);
  });

  it("reports set and not set", () => {
    expect(exaIntegration.status(ctx([])).level).toBe("not_configured");
    expect(exaIntegration.status(ctx([EXA_KEY_FIELD])).level).toBe(
      "configured",
    );
  });

  it("rejects a paste with spaces or non-ASCII characters", () => {
    const validate = exaIntegration.fields[0]!.validate!;
    expect(validate("abc def")).toMatch(/no spaces/);
    expect(validate("ключ")).toMatch(/ASCII/);
    expect(validate("0b1c2d3e-aaaa-bbbb-cccc-0123456789ab")).toBeUndefined();
  });
});
