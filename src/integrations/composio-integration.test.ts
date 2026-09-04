import { describe, expect, it } from "vitest";

import { composioIntegration } from "./composio-integration.js";
import { COMPOSIO_API_KEY_ENV } from "../composio/index.js";

const KEY = "apiKey";

function ctx(present: string[], states?: Record<string, string>) {
  return {
    presentFields: new Set(present),
    configured: present.includes(KEY),
    ...(states === undefined
      ? {}
      : { mcpServerStates: new Map(Object.entries(states)) }),
  };
}

describe("composioIntegration", () => {
  it("needs exactly one required field: the API key", () => {
    const required = composioIntegration.fields.filter((f) => f.required);
    expect(required).toHaveLength(1);
    expect(required[0]?.envVar).toBe(COMPOSIO_API_KEY_ENV);
    expect(required[0]?.secret).toBe(true);
  });

  it("says plainly that no key means no tools", () => {
    const status = composioIntegration.status(ctx([]));
    expect(status.level).toBe("not_configured");
    expect(status.detail).toMatch(/not loaded/);
  });

  it("reports connected once the MCP server is up", () => {
    expect(composioIntegration.status(ctx([KEY], { composio: "up" }))).toEqual({
      level: "connected",
      detail: "connected",
    });
  });

  it("distinguishes a saved key from a failed connection", () => {
    // These must not look the same: one is "wait a moment", the other
    // is "your key is wrong or Composio is down".
    expect(composioIntegration.status(ctx([KEY])).level).toBe("configured");
    expect(
      composioIntegration.status(ctx([KEY], { composio: "down" })).level,
    ).toBe("error");
  });

  it("rejects a non-ASCII key at entry", () => {
    // The key is sent as an x-api-key header; a smart quote from a
    // copy-paste would otherwise blow up opaquely inside fetch.
    const validate = composioIntegration.fields[0]?.validate;
    expect(validate?.("ak_plain_ascii")).toBeUndefined();
    expect(validate?.("ak_“fancy”")).toMatch(/ASCII/);
  });
});
