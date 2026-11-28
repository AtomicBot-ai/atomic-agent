import { describe, expect, it } from "vitest";

import { listedOrigin, mcpOriginAllowed } from "./mcp-origin.js";

const HOST = "nadyas-mac.local";

describe("mcpOriginAllowed (ATO-2475)", () => {
  it("lets no Origin and loopback origins in, refuses foreign ones without a list", () => {
    expect(mcpOriginAllowed(null, {}, HOST)).toBe(true);
    expect(mcpOriginAllowed("http://localhost:3000", {}, HOST)).toBe(true);
    expect(mcpOriginAllowed("http://127.0.0.1:8787", {}, HOST)).toBe(true);
    expect(mcpOriginAllowed("https://evil.example", {}, HOST)).toBe(false);
    expect(mcpOriginAllowed("null", {}, HOST)).toBe(false);
  });

  it("adds the exact origins the variable lists", () => {
    const env = { ATOMIC_AGENT_ALLOWED_ORIGINS: " https://App.example/ , http://192.168.1.5:3000" };
    expect(mcpOriginAllowed("https://app.example", env, HOST)).toBe(true);
    expect(mcpOriginAllowed("http://192.168.1.5:3000", env, HOST)).toBe(true);
    expect(mcpOriginAllowed("https://other.example", env, HOST)).toBe(false);
    expect(mcpOriginAllowed("https://app.example.evil.test", env, HOST)).toBe(false);
  });

  it("honours a wildcard only for an extension scheme", () => {
    const env = { ATOMIC_AGENT_ALLOWED_ORIGINS: "chrome-extension://*, moz-extension://abc*" };
    expect(listedOrigin("chrome-extension://abcdef", env)).toBe(true);
    expect(listedOrigin("moz-extension://abc123", env)).toBe(true);
    expect(listedOrigin("moz-extension://zzz", env)).toBe(false);
  });

  it("ignores a lone * and web wildcards, which would turn the spec's check off", () => {
    const env = { ATOMIC_AGENT_ALLOWED_ORIGINS: "*, https://*, http://*, https://app.example*" };
    for (const origin of ["https://evil.example", "http://evil.example", "https://app.example.evil.test"]) {
      expect(mcpOriginAllowed(origin, env, HOST), origin).toBe(false);
    }
  });
});
