import { describe, expect, it } from "vitest";

import {
  ANSWER_STYLE_HEADER,
  answerChannelForOrigin,
  buildAnswerStyleGuidance,
  TELEGRAM_REPLY_MAX_CHARS,
  type AnswerChannel,
} from "./answer-style.js";
import { buildPrompt } from "./build-prompt.js";
import type { BuildPromptInput } from "./build-prompt-types.js";
import { buildStablePrefix, type CapabilitiesSummary } from "./stable-prefix.js";
import { estimateTokens } from "./token-budget.js";
import { createEmptySessionState } from "../session/session-state.js";

const CAPS: CapabilitiesSummary = {
  platform: "linux",
  arch: "x64",
  browserChannel: "none",
  workingDir: "/repo",
  hasClipboard: false,
  hasWmctrl: false,
  hasNotifications: false,
};

const CHANNELS: readonly AnswerChannel[] = ["terminal", "desktop", "telegram", "discord"];

function prefix(answerStyle?: { channel: AnswerChannel; compact: boolean }): string {
  return buildStablePrefix({
    toolDescriptors: [],
    capabilities: CAPS,
    skillCatalog: [],
    ...(answerStyle ? { answerStyle } : {}),
  });
}

function block(text: string): string[] {
  const lines = text.split("\n");
  const start = lines.indexOf(ANSWER_STYLE_HEADER);
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("### "));
  return rest.slice(0, end === -1 ? undefined : end).filter((l) => l !== "");
}

describe("answerChannelForOrigin (ATO-966)", () => {
  it("maps the person-facing origins to their surface", () => {
    expect(answerChannelForOrigin("tui")).toBe("terminal");
    expect(answerChannelForOrigin("sidecar")).toBe("desktop");
    expect(answerChannelForOrigin("telegram")).toBe("telegram");
    expect(answerChannelForOrigin("discord")).toBe("discord");
  });

  it("gives no channel where no person reads the reply as chat", () => {
    for (const origin of ["fusion", "scheduler", "http", "cli", undefined]) {
      expect(answerChannelForOrigin(origin)).toBeUndefined();
    }
  });
});

describe("### answer-style in the stable prefix (ATO-966)", () => {
  it("is absent, byte for byte, when no style is passed", () => {
    expect(prefix()).not.toContain(ANSWER_STYLE_HEADER);
    const withBlock = prefix({ channel: "terminal", compact: false });
    // Removing exactly the block gives back the legacy prefix.
    const legacy = withBlock.replace(
      `${ANSWER_STYLE_HEADER}\n${buildAnswerStyleGuidance({ channel: "terminal", compact: false })}\n\n`,
      "",
    );
    expect(legacy).toBe(prefix());
  });

  it("sits right after ### rules and before ### skills", () => {
    const text = prefix({ channel: "desktop", compact: false });
    const rules = text.indexOf("### rules");
    const style = text.indexOf(ANSWER_STYLE_HEADER);
    const skills = text.indexOf("### skills");
    expect(rules).toBeGreaterThan(-1);
    expect(style).toBeGreaterThan(rules);
    expect(skills).toBeGreaterThan(style);
  });

  it("is deterministic per channel and mode (cache-stable across steps)", () => {
    for (const channel of CHANNELS) {
      for (const compact of [false, true]) {
        expect(prefix({ channel, compact })).toBe(prefix({ channel, compact }));
      }
    }
    // Every channel renders a different block.
    const full = new Set(CHANNELS.map((channel) => block(prefix({ channel, compact: false })).join("\n")));
    expect(full.size).toBe(CHANNELS.length);
  });

  it("carries the core rules in the full form", () => {
    const text = buildAnswerStyleGuidance({ channel: "desktop", compact: false });
    expect(text).toMatch(/^Lead with the answer or the result/);
    expect(text).toContain("Do not retell tool output");
    expect(text).toContain("as `code`");
    expect(text).toMatch(/Headings only when the reply runs past ~\d+ lines/);
    // The persona's exact-format rule still wins.
    expect(text).toContain("An exact format the request asks for overrides all of this.");
  });

  it("tells Telegram no tables and the character cap, and points long output to attachments", () => {
    for (const compact of [false, true]) {
      const text = buildAnswerStyleGuidance({ channel: "telegram", compact });
      expect(text).toContain("no tables");
      expect(text).toContain(String(TELEGRAM_REPLY_MAX_CHARS));
    }
    expect(buildAnswerStyleGuidance({ channel: "telegram", compact: false })).toContain("`attachments`");
    expect(TELEGRAM_REPLY_MAX_CHARS).toBeLessThan(4096);
  });

  it("keeps the short form short and still covers the same rules", () => {
    for (const channel of CHANNELS) {
      const full = buildAnswerStyleGuidance({ channel, compact: false });
      const compact = buildAnswerStyleGuidance({ channel, compact: true });
      expect(compact.split("\n")).toHaveLength(1);
      expect(compact).toContain("Answer first");
      expect(compact).toContain("tool output");
      expect(compact).toContain("`code`");
      expect(compact).toContain("Headings only");
      // Paid on every step of every turn: guard against growth.
      expect(estimateTokens(`${ANSWER_STYLE_HEADER}\n${full}`)).toBeLessThan(200);
      expect(estimateTokens(`${ANSWER_STYLE_HEADER}\n${compact}`)).toBeLessThan(60);
      expect(compact.length * 3).toBeLessThan(full.length);
    }
  });
});

describe("buildPrompt picks the answer-style form from the model mode (ATO-966)", () => {
  function input(extra: Partial<BuildPromptInput> = {}): BuildPromptInput {
    return {
      session: createEmptySessionState({ id: "answer-style", workingDir: "/repo" }),
      toolDescriptors: [],
      capabilities: CAPS,
      skillCatalog: [],
      tokenBudget: 8000,
      ...extra,
    };
  }

  it("renders no block without a channel", () => {
    expect(buildPrompt(input()).stablePrefix).not.toContain(ANSWER_STYLE_HEADER);
  });

  it("uses the short form for local and unset model modes", () => {
    const short = buildAnswerStyleGuidance({ channel: "telegram", compact: true });
    expect(buildPrompt(input({ answerChannel: "telegram" })).stablePrefix).toContain(short);
    const modelMode = { mode: "local" as const, source: "provider" as const, providerId: "local", modelId: "m" };
    expect(buildPrompt(input({ answerChannel: "telegram", modelMode })).stablePrefix).toContain(short);
  });

  it("uses the full form for a cloud model", () => {
    const modelMode = { mode: "cloud" as const, source: "provider" as const, providerId: "remote", modelId: "m" };
    const built = buildPrompt(input({ answerChannel: "telegram", modelMode, contextWindow: 200000 }));
    expect(built.stablePrefix).toContain(buildAnswerStyleGuidance({ channel: "telegram", compact: false }));
  });
});
