import { describe, expect, it } from "vitest";

import type { AtomicAgentConfig } from "../config/index.js";
import { handoffWindowFor, parseHandoffArgs } from "./handoff-command.js";

describe("parseHandoffArgs", () => {
  it("requires --from and accepts only the two agents", () => {
    expect(parseHandoffArgs([])).toEqual({
      error: "--from is required (claude-code or codex)",
    });
    expect(parseHandoffArgs(["--from", "hermes"])).toEqual({
      error: "--from must be claude-code or codex, not hermes",
    });
  });

  it("defaults to the latest session, opening it", () => {
    expect(parseHandoffArgs(["--from", "claude-code"])).toMatchObject({
      agent: "claude-code",
      session: "latest",
      list: false,
      json: false,
      open: true,
      limit: 10,
    });
  });

  it("reads every option", () => {
    const parsed = parseHandoffArgs([
      "--from",
      "codex",
      "--session",
      "0199a1",
      "--note",
      "run the tests first",
      "--list",
      "--limit",
      "5",
      "--json",
      "--no-open",
    ]);
    expect(parsed).toMatchObject({
      agent: "codex",
      session: "0199a1",
      note: "run the tests first",
      list: true,
      limit: 5,
      json: true,
      open: false,
    });
  });

  it("refuses a flag without its value and unknown flags", () => {
    expect(parseHandoffArgs(["--from", "codex", "--session"])).toHaveProperty("error");
    expect(parseHandoffArgs(["--from", "codex", "--limit", "0"])).toHaveProperty("error");
    expect(parseHandoffArgs(["--from", "codex", "--bogus"])).toEqual({
      error: "unknown flag: --bogus",
    });
  });

  it("returns help", () => {
    expect(parseHandoffArgs(["--help"])).toEqual({ help: true });
  });
});

describe("parseHandoffArgs --context", () => {
  it("defaults to the configured window and accepts 0 to keep everything", () => {
    expect(parseHandoffArgs(["--from", "codex"])).toMatchObject({ context: null });
    expect(parseHandoffArgs(["--from", "codex", "--context", "0"])).toMatchObject({ context: 0 });
    expect(parseHandoffArgs(["--from", "codex", "--context", "65536"])).toMatchObject({ context: 65536 });
    expect(parseHandoffArgs(["--from", "codex", "--context", "-1"])).toHaveProperty("error");
  });
});

describe("handoffWindowFor", () => {
  const config = (
    provider: Record<string, unknown> | null,
    contextSize = 65_536,
  ): Pick<AtomicAgentConfig, "llm" | "localModels"> =>
    ({
      localModels: { managed: { contextSize } },
      llm:
        provider === null
          ? undefined
          : { activeTextProvider: "p", providers: [{ id: "p", ...provider }] },
    }) as unknown as Pick<AtomicAgentConfig, "llm" | "localModels">;

  it("uses the managed size for a local provider or no provider", () => {
    expect(handoffWindowFor(config(null))).toBe(65_536);
    expect(handoffWindowFor(config({ kind: "llama-server" }))).toBe(65_536);
    expect(
      handoffWindowFor(config({ kind: "openai-compatible", baseUrl: "http://localhost:1234/v1" })),
    ).toBe(65_536);
  });

  it("uses a cloud model's configured window", () => {
    const provider = {
      kind: "openrouter",
      defaultChatModel: "m",
      userModels: [{ id: "m", kind: "chat", contextWindow: 200_000 }],
    };
    expect(handoffWindowFor(config(provider))).toBe(200_000);
  });

  it("skips fitting for a cloud model whose window is unknown", () => {
    expect(handoffWindowFor(config({ kind: "openrouter", defaultChatModel: "m" }))).toBe(0);
  });
});
