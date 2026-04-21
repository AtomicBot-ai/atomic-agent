import { describe, it, expect } from "vitest";
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

  it("keeps the full world snapshot even when the token budget is tight", () => {
    const huge = "x".repeat(20_000);
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
    });
    expect(prompt.tail).toContain(huge);
    expect(prompt.tokens.worldSnapshot).toBeGreaterThan(
      prompt.limits.worldSnapshot,
    );
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
    expect(prompt.tokens.session).toBeLessThanOrEqual(prompt.limits.session);
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
