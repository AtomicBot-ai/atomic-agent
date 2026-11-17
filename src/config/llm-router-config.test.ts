import { describe, expect, it } from "vitest";

import { parseUserConfigFile, USER_CONFIG_VERSION } from "./config-schema.js";
import { parseLlmRouterConfig } from "./llm-router-config.js";

const IDS = new Set(["openrouter", "groq"]);

describe("parseLlmRouterConfig (ATO-483)", () => {
  it("is off unless enabled is true", () => {
    expect(parseLlmRouterConfig({}, IDS, "llm.router")).toEqual({ enabled: false, rules: [] });
  });

  it("reads rules in order with their conditions", () => {
    const parsed = parseLlmRouterConfig(
      {
        enabled: true,
        rules: [
          { name: "short", when: { maxTokens: 40, needsTools: true }, provider: "groq" },
          {
            when: {
              minTokens: 100,
              hasImage: false,
              contains: ["deploy"],
              matches: "^fix\\b",
              workingDir: "~/work",
            },
            provider: "openrouter",
          },
          { provider: "openrouter" },
        ],
      },
      IDS,
      "llm.router",
    );
    expect(parsed.enabled).toBe(true);
    expect(parsed.rules.map((r) => r.provider)).toEqual(["groq", "openrouter", "openrouter"]);
    expect(parsed.rules[0]).toEqual({
      name: "short",
      provider: "groq",
      when: { maxTokens: 40, needsTools: true },
    });
    expect(parsed.rules[2]!.when).toBeUndefined();
  });

  it("keeps a rule for a provider that is not configured (skipped at turn time)", () => {
    const parsed = parseLlmRouterConfig(
      { enabled: true, rules: [{ provider: "removed" }] },
      IDS,
      "llm.router",
    );
    expect(parsed.rules).toEqual([{ provider: "removed" }]);
  });

  it("refuses bad shapes with the field named", () => {
    const bad: Array<[unknown, RegExp]> = [
      [{ enabled: "yes" }, /llm\.router\.enabled/],
      [{ rules: {} }, /llm\.router\.rules/],
      [{ rules: [{}] }, /rules\[0\]\.provider/],
      [{ rules: [{ provider: "groq", when: { tokens: 3 } }] }, /unknown condition/],
      [{ rules: [{ provider: "groq", when: { maxTokens: -1 } }] }, /maxTokens/],
      [{ rules: [{ provider: "groq", when: { minTokens: 9, maxTokens: 3 } }] }, /must not exceed/],
      [{ rules: [{ provider: "groq", when: { contains: [] } }] }, /contains/],
      [{ rules: [{ provider: "groq", when: { matches: "(" } }] }, /regular expression/],
      [{ rules: [{ provider: "groq", when: { hasImage: 1 } }] }, /hasImage/],
    ];
    for (const [raw, message] of bad) {
      expect(() => parseLlmRouterConfig(raw, IDS, "llm.router")).toThrow(message);
    }
  });

  it("rides through the config file parse and is absent by default", () => {
    const base = {
      version: USER_CONFIG_VERSION,
      llm: {
        activeTextProvider: "openrouter",
        activeEmbeddingProvider: "local-llama",
        toolTransport: "auto" as const,
        providers: [
          { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19091" },
          { id: "openrouter", kind: "openrouter", defaultChatModel: "openai/gpt-4o-mini" },
        ],
      },
    };
    expect(parseUserConfigFile(base).llm?.router).toBeUndefined();
    const withRouter = parseUserConfigFile({
      ...base,
      llm: { ...base.llm, router: { enabled: true, rules: [{ provider: "openrouter" }] } },
    });
    expect(withRouter.llm?.router).toEqual({
      enabled: true,
      rules: [{ provider: "openrouter" }],
    });
  });
});
