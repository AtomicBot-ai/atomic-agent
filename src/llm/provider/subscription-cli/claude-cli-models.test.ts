import { describe, expect, it } from "vitest";

import { CLAUDE_CLI_CHAT_MODELS, CLAUDE_CLI_MODEL_ALIASES, CLAUDE_CLI_MODEL_IDS } from "./claude-cli-models.js";

describe("CLAUDE_CLI_CHAT_MODELS", () => {
  it("offers the current pinned Claude models (ATO-1484)", () => {
    for (const id of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2"]) {
      expect(CLAUDE_CLI_CHAT_MODELS).toContain(id);
    }
  });

  it("lists aliases first and has no duplicates", () => {
    expect(CLAUDE_CLI_CHAT_MODELS.slice(0, CLAUDE_CLI_MODEL_ALIASES.length)).toEqual([...CLAUDE_CLI_MODEL_ALIASES]);
    expect(new Set(CLAUDE_CLI_CHAT_MODELS).size).toBe(CLAUDE_CLI_MODEL_ALIASES.length + CLAUDE_CLI_MODEL_IDS.length);
  });
});
