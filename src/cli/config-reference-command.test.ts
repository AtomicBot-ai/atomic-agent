import { describe, expect, it } from "vitest";

import { maskedValue } from "./config-reference-command.js";
import { formatSettingValue } from "../config/settings-value-mask.js";

describe("maskedValue (config list --json / --describe)", () => {
  it("masks a secret-named string and leaves other leaves alone", () => {
    expect(maskedValue("web.search.exa.apiKeyEnv", "EXA_API_KEY")).toBe("***");
    expect(maskedValue("agent.tokenBudget", 3000)).toBe(3000);
    expect(maskedValue("log.level", "info")).toBe("info");
    expect(maskedValue("telegram.token", "")).toBe("");
  });

  it("walks objects and arrays and masks secret-named keys at any depth", () => {
    expect(
      maskedValue("providers", [{ name: "a", apiKey: "sk-1", nested: { password: "p", tokenBudget: 5 } }]),
    ).toEqual([{ name: "a", apiKey: "***", nested: { password: "***", tokenBudget: 5 } }]);
  });

  it("masks every value under env and headers, whatever the key is called", () => {
    const value = [
      {
        name: "gh",
        enabled: true,
        env: { GITHUB_TOKEN: "ghp_abc", PORT: 8080, EMPTY: "", DEBUG: false },
        transport: { kind: "streamable_http", url: "https://x.invalid", headers: { Authorization: "Bearer b", "X-Org": ["o1"] } },
      },
    ];
    const out = maskedValue("mcp.servers", value);
    expect(JSON.stringify(out)).not.toMatch(/ghp_abc|Bearer b|o1|8080/);
    expect(out).toEqual([
      {
        name: "gh",
        enabled: true,
        env: { GITHUB_TOKEN: "***", PORT: "***", EMPTY: "", DEBUG: false },
        transport: { kind: "streamable_http", url: "https://x.invalid", headers: { Authorization: "***", "X-Org": ["***"] } },
      },
    ]);
    // A key that is itself an env map.
    expect(maskedValue("some.env", { A: "1" })).toEqual({ A: "***" });
  });

  it("formatSettingValue (TUI /settings, config list --describe) prints the masked tree", () => {
    const text = formatSettingValue("mcp.servers", [{ name: "gh", env: { GITHUB_TOKEN: "ghp_abc" } }]);
    expect(text).not.toContain("ghp_abc");
    expect(text).toBe('[{"name":"gh","env":{"GITHUB_TOKEN":"***"}}]');
    expect(formatSettingValue("telegram.botToken", "123:abc")).toBe("***");
    expect(formatSettingValue("agent.tokenBudget", 3000)).toBe("3000");
  });
});
