import { describe, expect, it } from "vitest";
import { SECRET_ALLOWLIST, selectSecrets } from "./map-secrets.js";

describe("selectSecrets", () => {
  it("returns only allowlisted keys, in allowlist order", () => {
    const env = new Map([
      ["AIMLAPI_API_KEY", "aim-key"],
      ["OPENROUTER_API_KEY", "or-key"],
      ["SOME_OTHER_KEY", "ignored"],
    ]);
    const result = selectSecrets(env);
    expect(result.map((s) => s.key)).toEqual([
      "OPENROUTER_API_KEY",
      "AIMLAPI_API_KEY",
    ]);
  });

  it("drops keys not in the allowlist", () => {
    const env = new Map([
      ["ANTHROPIC_API_KEY", "x"],
      ["TELEGRAM_BOT_TOKEN", "y"],
    ]);
    expect(selectSecrets(env)).toEqual([]);
  });

  it("drops empty values", () => {
    const env = new Map([
      ["OPENROUTER_API_KEY", ""],
      ["AIMLAPI_API_KEY", "present"],
    ]);
    const result = selectSecrets(env);
    expect(result).toEqual([{ key: "AIMLAPI_API_KEY", value: "present" }]);
  });

  it("returns an empty list for an empty env map", () => {
    expect(selectSecrets(new Map())).toEqual([]);
  });

  it("exposes exactly the two provider keys in the allowlist", () => {
    expect([...SECRET_ALLOWLIST]).toEqual([
      "OPENROUTER_API_KEY",
      "AIMLAPI_API_KEY",
    ]);
  });
});
