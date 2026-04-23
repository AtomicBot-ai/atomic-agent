import { describe, it, expect } from "vitest";
import {
  GEMMA4_THINK_PROFILE,
  PLAIN_INSTRUCT_PROFILE,
  QWEN_THINK_PROFILE,
} from "../llm/model-profile.js";
import { buildPrompt } from "./build-prompt.js";
import { createEmptySessionState } from "../session/session-state.js";
import type { SessionState } from "../session/session-state.js";
import type {
  CapabilitiesSummary,
  SkillCatalogEntry,
  ToolDescriptor,
} from "./stable-prefix.js";
import { estimateTokens, truncateToTokens } from "./token-budget.js";

function mkSession(overrides: Partial<SessionState> = {}): SessionState {
  const base = createEmptySessionState({
    id: "s",
    workingDir: "/work",
  });
  // Seed with one user turn so prompt tests have something to render in
  // the conversation section.
  return {
    ...base,
    turns: [{ kind: "user", text: "Check inbox", at: 1 }],
    ...overrides,
  };
}

const TOOLS: ToolDescriptor[] = [
  {
    name: "browser.navigate",
    summary: "Navigate the current tab to a URL.",
    argsSchema: '{"url": string}',
  },
  {
    name: "finish",
    summary: "Signal goal completion.",
    argsSchema: '{"summary": string}',
  },
];

const CAPS: CapabilitiesSummary = {
  platform: "darwin",
  arch: "arm64",
  browserChannel: "chrome",
  workingDir: "/work",
  hasClipboard: true,
  hasWmctrl: false,
  hasNotifications: true,
};

const SKILLS: SkillCatalogEntry[] = [
  {
    name: "check-gmail-inbox",
    description: "Check Gmail inbox for unread messages",
    source: "global",
  },
];

describe("buildPrompt", () => {
  it("places the stable prefix first and keeps it byte-stable for equal inputs", () => {
    const a = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    const b = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    expect(a.stablePrefix).toBe(b.stablePrefix);
    expect(a.text.startsWith(a.stablePrefix)).toBe(true);
  });

  it("stable prefix does not depend on session or latest result", () => {
    const a = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    const b = buildPrompt({
      session: mkSession({
        stepCount: 3,
        latestResult: {
          tool: "browser.navigate",
          status: "ok",
          summary: "loaded https://mail.google.com",
        },
      }),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    expect(a.stablePrefix).toBe(b.stablePrefix);
    expect(a.text).not.toBe(b.text);
  });

  it("renders the last user message in the conversation section", () => {
    const prompt = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    expect(prompt.tail).toContain("### conversation");
    expect(prompt.tail).toContain("user: Check inbox");
  });

  it("appends a think prelude for qwen think profiles", () => {
    const prompt = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      profile: QWEN_THINK_PROFILE,
    });
    expect(prompt.tail.endsWith("<think>\n")).toBe(true);
  });

  it("injects gemma reasoning tokens into the stable prefix and tail", () => {
    const prompt = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      profile: GEMMA4_THINK_PROFILE,
    });
    expect(prompt.stablePrefix.startsWith("### system\n<|think|>")).toBe(true);
    expect(prompt.tail.endsWith("<|channel>thought\n")).toBe(true);
  });

  it("does not append a think prelude for plain profiles", () => {
    const prompt = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      profile: PLAIN_INSTRUCT_PROFILE,
    });
    expect(prompt.tail.endsWith("<think>\n")).toBe(false);
  });

  it("shows (no messages yet) when there are no turns", () => {
    const session = createEmptySessionState({
      id: "empty",
      workingDir: "/work",
    });
    const prompt = buildPrompt({
      session,
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    expect(prompt.tail).toContain("(no messages yet)");
  });

  it("renders tool catalog, capabilities, and skill catalog in the prefix", () => {
    const prompt = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    expect(prompt.stablePrefix).toContain("- browser.navigate");
    expect(prompt.stablePrefix).toContain("browser: chrome");
    expect(prompt.stablePrefix).toContain("check-gmail-inbox");
  });

  it("renders recorded turns (tool-call + tool-result) in the conversation section", () => {
    const base = mkSession();
    const prompt = buildPrompt({
      session: {
        ...base,
        turns: [
          ...base.turns,
          {
            kind: "assistant_tool_call",
            tool: "browser.read_aria",
            args: {},
            at: 1,
          },
          {
            kind: "tool_result",
            tool: "browser.read_aria",
            status: "error",
            summary: "timed out waiting for page",
            at: 2,
          },
        ],
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    expect(prompt.tail).toContain("assistant_tool_call: browser.read_aria");
    expect(prompt.tail).toContain(
      "tool_result[browser.read_aria error]: timed out waiting for page",
    );
  });

  it("renders loaded skills in the tail", () => {
    const prompt = buildPrompt({
      session: mkSession({
        loadedSkills: [
          {
            name: "check-gmail-inbox",
            version: "0.1.0",
            body: "Step 1. Open gmail.com",
            loadedAt: Date.now(),
          },
        ],
      }),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    expect(prompt.tail).toContain("--- skill:check-gmail-inbox v0.1.0 ---");
    expect(prompt.tail).toContain("Open gmail.com");
  });

  it("renders world snapshot when present", () => {
    const prompt = buildPrompt({
      session: mkSession({
        worldSnapshot: {
          kind: "browser",
          digest: "abc123",
          text: "[1] button Sign In\n[2] textbox Email",
          capturedAt: Date.now(),
        },
      }),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    expect(prompt.tail).toContain("kind: browser");
    expect(prompt.tail).toContain("digest: abc123");
    expect(prompt.tail).toContain("button Sign In");
  });

  it("keeps the full chat transcript even when tokenBudget is tiny", () => {
    const base = mkSession();
    const longTurns = [];
    for (let i = 0; i < 30; i += 1) {
      longTurns.push({
        kind: "user" as const,
        text: `noise ${i} ${"q".repeat(50)}`,
        at: i,
      });
      longTurns.push({
        kind: "assistant_reply" as const,
        text: `noise reply ${i} ${"r".repeat(50)}`,
        at: i,
      });
    }
    const session = {
      ...base,
      turns: [
        ...longTurns,
        { kind: "user" as const, text: "the latest important question", at: 999 },
      ],
    };
    const prompt = buildPrompt({
      session,
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      tokenBudget: 400,
    });
    expect(prompt.tail).toContain("the latest important question");
    expect(prompt.tail).toContain("noise 0");
    expect(prompt.tail).toContain("noise 29");
    expect(prompt.tail).not.toContain("[earlier messages omitted]");
  });

  it("trims an oversized world snapshot down to the safety-net cap", () => {
    const huge = "x".repeat(200_000);
    const prompt = buildPrompt({
      session: mkSession({
        worldSnapshot: {
          kind: "browser",
          digest: "h",
          text: huge,
          capturedAt: Date.now(),
        },
      }),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      tokenBudget: 500,
      worldSnapshotMaxTokens: 1000,
    });
    expect(prompt.tail).toContain("[truncated]");
    expect(prompt.tokens.worldSnapshot).toBeLessThanOrEqual(1000);
    expect(prompt.truncation.worldSnapshot).toBe(true);
  });

  it("keeps a modest world snapshot intact when well below the cap", () => {
    const modest = "button Sign In\nlink About";
    const prompt = buildPrompt({
      session: mkSession({
        worldSnapshot: {
          kind: "browser",
          digest: "h",
          text: modest,
          capturedAt: Date.now(),
        },
      }),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    expect(prompt.tail).toContain(modest);
    expect(prompt.truncation.worldSnapshot).toBe(false);
  });

  it("renders transientNotice in a ### notice section before ### response", () => {
    const prompt = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      transientNotice: "you are looping on ref=e175",
    });
    expect(prompt.tail).toContain("### notice");
    expect(prompt.tail).toContain("you are looping on ref=e175");
    const noticeIdx = prompt.tail.indexOf("### notice");
    const responseIdx = prompt.tail.indexOf("### response");
    expect(noticeIdx).toBeGreaterThan(-1);
    expect(noticeIdx).toBeLessThan(responseIdx);
  });

  it("does not include transientNotice in the stable prefix", () => {
    const withNotice = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      transientNotice: "one-shot hint",
    });
    const withoutNotice = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    expect(withNotice.stablePrefix).toBe(withoutNotice.stablePrefix);
    expect(withoutNotice.tail).not.toContain("### notice");
  });

  it("still truncates the session section when facts+skills overflow", () => {
    const bigSkill = "a".repeat(20_000);
    const prompt = buildPrompt({
      session: mkSession({
        loadedSkills: [
          {
            name: "huge",
            version: "1.0.0",
            body: bigSkill,
            loadedAt: Date.now(),
          },
        ],
      }),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      tokenBudget: 500,
    });
    expect(prompt.truncated).toBe(true);
    expect(prompt.truncation.session).toBe(true);
    expect(prompt.tokens.session).toBeLessThanOrEqual(prompt.limits.session);
  });

  it("folds older turns into a deterministic summary above the visible tail", () => {
    const base = mkSession();
    const longTurns: SessionState["turns"] = [];
    for (let i = 0; i < 200; i += 1) {
      longTurns.push({
        kind: "user",
        text: `old noise ${i} ${"q".repeat(80)}`,
        at: i,
      });
      longTurns.push({
        kind: "assistant_reply",
        text: `old reply ${i} ${"r".repeat(80)}`,
        at: i,
      });
    }
    const session = {
      ...base,
      turns: [
        ...longTurns,
        { kind: "user" as const, text: "the latest important question", at: 9_999 },
      ],
    };
    const prompt = buildPrompt({
      session,
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      conversationMaxTokens: 400,
    });
    expect(prompt.tail).toContain("the latest important question");
    expect(prompt.tail).toMatch(/summary: \d+ older turns dropped/);
    expect(prompt.truncation.conversation).toBe(true);
    expect(prompt.droppedTurns).toBeGreaterThan(0);
    expect(prompt.tokens.conversation).toBeLessThanOrEqual(
      prompt.conversationCapEffective,
    );
  });

  it("leaves a typical-length transcript untouched when well under the cap", () => {
    const base = mkSession();
    const turns: SessionState["turns"] = [];
    for (let i = 0; i < 10; i += 1) {
      turns.push({ kind: "user", text: `ping ${i}`, at: i });
      turns.push({ kind: "assistant_reply", text: `pong ${i}`, at: i });
    }
    const prompt = buildPrompt({
      session: { ...base, turns },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    expect(prompt.tail).not.toContain("summary:");
    expect(prompt.truncation.conversation).toBe(false);
    expect(prompt.droppedTurns).toBe(0);
  });

  it("clamps the effective conversation cap on a tiny-context model", () => {
    const prompt = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      profile: { ...PLAIN_INSTRUCT_PROFILE, contextWindow: 4096 },
      completionMaxTokens: 512,
      conversationMaxTokens: 32_000,
    });
    expect(prompt.contextWindow).toBe(4096);
    expect(prompt.conversationCapEffective).toBeLessThan(32_000);
    expect(prompt.conversationCapEffective).toBeLessThan(4096);
  });

  it("keeps the configured cap when the model context window is unknown", () => {
    const prompt = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      profile: PLAIN_INSTRUCT_PROFILE,
      conversationMaxTokens: 20_000,
    });
    expect(prompt.contextWindow).toBeNull();
    expect(prompt.conversationCapEffective).toBe(20_000);
  });

  it("keeps the stable prefix byte-stable as the conversation grows", () => {
    const emptyPrompt = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    const longTurns: SessionState["turns"] = [];
    for (let i = 0; i < 100; i += 1) {
      longTurns.push({ kind: "user", text: `msg ${i}`, at: i });
      longTurns.push({ kind: "assistant_reply", text: `ack ${i}`, at: i });
    }
    const grownPrompt = buildPrompt({
      session: { ...mkSession(), turns: longTurns },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    expect(grownPrompt.stablePrefix).toBe(emptyPrompt.stablePrefix);
  });
});

describe("buildPrompt profile section", () => {
  it("omits the section entirely when profileFacts is undefined", () => {
    const prompt = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    expect(prompt.tail).not.toContain("### profile");
    expect(prompt.tokens.profile).toBe(0);
    expect(prompt.truncation.profile).toBe(false);
  });

  it("renders (no profile) when an empty array is passed", () => {
    const prompt = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      profileFacts: [],
    });
    expect(prompt.tail).toContain("### profile");
    expect(prompt.tail).toContain("(no profile)");
  });

  it("places ### profile between ### session and ### world", () => {
    const prompt = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      profileFacts: [{ key: "language", value: "ru", updatedAt: 1 }],
    });
    const sessionIdx = prompt.tail.indexOf("### session");
    const profileIdx = prompt.tail.indexOf("### profile");
    const worldIdx = prompt.tail.indexOf("### world");
    expect(sessionIdx).toBeLessThan(profileIdx);
    expect(profileIdx).toBeLessThan(worldIdx);
    expect(prompt.tail).toContain("- language: ru");
  });

  it("keeps the stable prefix byte-stable across profile edits", () => {
    const empty = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      profileFacts: [],
    });
    const filled = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      profileFacts: [
        { key: "name", value: "Alex", updatedAt: 1 },
        { key: "timezone", value: "Europe/Moscow", updatedAt: 2 },
      ],
    });
    expect(empty.stablePrefix).toBe(filled.stablePrefix);
    expect(empty.tail).not.toBe(filled.tail);
  });

  it("truncates a giant profile under profileMaxTokens", () => {
    const giantValue = "x".repeat(20_000);
    const prompt = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      profileFacts: [{ key: "blob", value: giantValue, updatedAt: 1 }],
      profileMaxTokens: 50,
    });
    expect(prompt.tail).toContain("### profile");
    expect(prompt.tail).toContain("[truncated]");
    expect(prompt.tokens.profile).toBeLessThanOrEqual(50);
    expect(prompt.truncation.profile).toBe(true);
    expect(prompt.truncated).toBe(true);
  });
});

describe("token-budget helpers", () => {
  it("estimateTokens is monotonic in length", () => {
    expect(estimateTokens("a".repeat(10))).toBeLessThan(
      estimateTokens("a".repeat(100)),
    );
  });

  it("truncateToTokens produces shorter output with marker", () => {
    const input = "word ".repeat(500);
    const out = truncateToTokens(input, 20);
    expect(out.length).toBeLessThan(input.length);
    expect(out).toContain("[truncated]");
  });

  it("truncateToTokens with max=0 returns empty", () => {
    expect(truncateToTokens("abc", 0)).toBe("");
  });
});
