import { describe, expect, it } from "vitest";

import { compareChatRows, scoreChat } from "./openrouter-chat-score.js";

const row = (id: string, created?: number) => ({
  id,
  context_length: 400_000,
  ...(created !== undefined ? { created } : {}),
});

describe("scoreChat: family bonuses cover later generations (ATO-1340)", () => {
  it.each([
    ["openai/gpt-6.2-sol", "openai/gpt-5.4"],
    ["qwen/qwen4-235b", "qwen/qwen3.7-35b"],
    ["qwen/qwen3.8-35b", "qwen/qwen3.6-35b-a3b"],
    ["moonshotai/kimi-k3", "moonshotai/kimi-k2.6"],
    ["anthropic/claude-fable-5.2", "anthropic/claude-sonnet-5"],
    ["google/gemini-4-pro", "google/gemini-3.1-pro"],
  ])("scores %s no lower than %s", (newer, older) => {
    expect(scoreChat(row(newer))).toBeGreaterThanOrEqual(scoreChat(row(older)));
  });

  it("keeps older generations below their family's bonus", () => {
    expect(scoreChat(row("openai/gpt-4.1"))).toBeLessThan(scoreChat(row("openai/gpt-6")));
    expect(scoreChat(row("moonshotai/kimi-k2.5"))).toBeLessThan(scoreChat(row("moonshotai/kimi-k3")));
    expect(scoreChat(row("anthropic/claude-sonnet-4"))).toBeLessThan(
      scoreChat(row("anthropic/claude-sonnet-5.5")),
    );
  });

  it("drops batch-only variants and keeps the regular id", () => {
    expect(scoreChat(row("openai/gpt-6.2-sol:batch"))).toBe(-1);
    expect(scoreChat(row("openai/gpt-6.2-sol"))).toBeGreaterThan(0);
  });
});

describe("compareChatRows", () => {
  it("puts the newer of two equally scored rows first", () => {
    const sorted = [row("openai/gpt-5.4", 1_760_000_000), row("openai/gpt-6.2-sol", 1_790_000_000)]
      .sort(compareChatRows)
      .map((r) => r.id);
    expect(sorted).toEqual(["openai/gpt-6.2-sol", "openai/gpt-5.4"]);
  });

  it("still lets a higher score win over a newer date", () => {
    const sorted = [row("vendor/new-thing", 1_790_000_000), row("openai/gpt-5.4", 1_700_000_000)]
      .sort(compareChatRows)
      .map((r) => r.id);
    expect(sorted).toEqual(["openai/gpt-5.4", "vendor/new-thing"]);
  });

  it("falls back to the id when nothing else differs", () => {
    const sorted = [row("vendor/b"), row("vendor/a")].sort(compareChatRows).map((r) => r.id);
    expect(sorted).toEqual(["vendor/a", "vendor/b"]);
  });
});
