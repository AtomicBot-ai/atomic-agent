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
        turns: [
          { kind: "user", text: "Check inbox", at: 1 },
          { kind: "user", text: "Any update?", at: 2 },
        ],
      }),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    expect(a.stablePrefix).toBe(b.stablePrefix);
    expect(a.text).not.toBe(b.text);
  });

  it("pins the `Emit one JSON tool call now` instruction in the stable prefix (KV-cache hygiene)", () => {
    const prompt = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    expect(prompt.stablePrefix).toContain("### instructions");
    expect(prompt.stablePrefix).toContain(
      "Emit one JSON tool call now. Use `reply` for natural-language answers to the user.",
    );
    expect(prompt.tail).not.toContain("### response");
    expect(prompt.tail).not.toContain("Emit one JSON tool call now");
  });

  it("pins a short `### respond` anchor at the end of the tail (anti-loop)", () => {
    const prompt = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    expect(prompt.tail).toContain("### respond\nRespond now.");
    expect(prompt.stablePrefix).not.toContain("### respond");
    // Anchor must sit after the conversation section so it is the last
    // directive the model sees before generation.
    const respondIdx = prompt.tail.indexOf("### respond");
    const conversationIdx = prompt.tail.indexOf("### conversation");
    expect(respondIdx).toBeGreaterThan(conversationIdx);
  });

  it("places the `### respond` anchor just before the `<think>` prefill for reasoning profiles", () => {
    const prompt = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      profile: QWEN_THINK_PROFILE,
    });
    expect(prompt.tail.endsWith("<think>\n")).toBe(true);
    const respondIdx = prompt.tail.lastIndexOf("### respond");
    const thinkIdx = prompt.tail.lastIndexOf("<think>");
    expect(respondIdx).toBeGreaterThan(-1);
    expect(thinkIdx).toBeGreaterThan(respondIdx);
  });

  it("step and turn counters do not leak into the prompt text (KV-cache hygiene)", () => {
    const a = buildPrompt({
      session: mkSession({ stepCount: 0, turnCount: 0 }),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    const b = buildPrompt({
      session: mkSession({ stepCount: 99, turnCount: 42 }),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    expect(a.text).toBe(b.text);
    expect(a.tail).not.toMatch(/^step:|^turn:/m);
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
    expect(prompt.tail).toContain("### loaded-skills");
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

  it("renders transientNotice in a ### notice section after ### conversation", () => {
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
    const conversationIdx = prompt.tail.indexOf("### conversation");
    expect(noticeIdx).toBeGreaterThan(-1);
    expect(noticeIdx).toBeGreaterThan(conversationIdx);
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
    expect(prompt.truncation.loadedSkills).toBe(true);
    const sessionTok =
      prompt.tokens.loadedSkills + prompt.tokens.sessionFacts;
    expect(sessionTok).toBeLessThanOrEqual(prompt.limits.session);
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

  it("orders tail from stable to hot: loaded-skills, profile, memory-index, session-facts, recalled, world, conversation", () => {
    const session = mkSession({
      knownFacts: [{ text: "pinned context" }],
      loadedSkills: [
        {
          name: "s",
          version: "1",
          body: "body",
          loadedAt: 1,
        },
      ],
      recalledNotes: [
        {
          id: 1,
          content: "n",
          tags: [],
          metadata: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      memoryIndex: [{ id: 2, preview: "p", tags: [], updatedAt: 1 }],
    });
    const prompt = buildPrompt({
      session,
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      profileFacts: [
        { key: "k", value: "v", updatedAt: 1, pinned: true, keywords: [] },
      ],
    });
    const idx = (h: string) => prompt.tail.indexOf(h);
    expect(idx("### loaded-skills")).toBeLessThan(idx("### profile"));
    expect(idx("### profile")).toBeLessThan(idx("### memory-index"));
    expect(idx("### memory-index")).toBeLessThan(idx("### session-facts"));
    expect(idx("### session-facts")).toBeLessThan(idx("### recalled"));
    expect(idx("### recalled")).toBeLessThan(idx("### world"));
    expect(idx("### world")).toBeLessThan(idx("### conversation"));
  });

  it("leaves loaded-skills and profile blocks byte-identical when only knownFacts change", () => {
    const skills = [
      {
        name: "check-gmail-inbox",
        version: "0.1.0",
        body: "Step 1. Open gmail.com",
        loadedAt: Date.now(),
      },
    ];
    const prof = [
      { key: "language", value: "ru", updatedAt: 1, pinned: true, keywords: [] },
    ];
    const a = buildPrompt({
      session: mkSession({ loadedSkills: skills, knownFacts: [] }),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      profileFacts: prof,
    });
    const b = buildPrompt({
      session: mkSession({
        loadedSkills: skills,
        knownFacts: [{ text: "new ephemeral fact" }],
      }),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      profileFacts: prof,
    });
    const slice = (s: string, h: string) => {
      const from = s.indexOf(h);
      if (from < 0) return "";
      const next = s.indexOf("###", from + h.length);
      return next < 0 ? s.slice(from) : s.slice(from, next);
    };
    expect(slice(a.tail, "### loaded-skills")).toBe(
      slice(b.tail, "### loaded-skills"),
    );
    expect(slice(a.tail, "### profile")).toBe(slice(b.tail, "### profile"));
    expect(b.tail).toContain("new ephemeral fact");
  });

  it("produces an identical ### profile block on repeated builds with the same profileFacts", () => {
    const facts = [
      { key: "a", value: "b", updatedAt: 1, pinned: true, keywords: [] },
    ];
    const p1 = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      profileFacts: facts,
    });
    const p2 = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      profileFacts: facts,
    });
    const extract = (t: string) => {
      const a = t.indexOf("### profile");
      if (a < 0) return "";
      const b = t.indexOf("###", a + 4);
      return b < 0 ? t.slice(a) : t.slice(a, b);
    };
    expect(extract(p1.tail)).toBe(extract(p2.tail));
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

  it("places ### profile after optional loaded-skills and before ### world", () => {
    const prompt = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      profileFacts: [
        { key: "language", value: "ru", updatedAt: 1, pinned: true, keywords: [] },
      ],
    });
    const loadedIdx = prompt.tail.indexOf("### loaded-skills");
    const profileIdx = prompt.tail.indexOf("### profile");
    const worldIdx = prompt.tail.indexOf("### world");
    if (loadedIdx >= 0) {
      expect(loadedIdx).toBeLessThan(profileIdx);
    }
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
        { key: "name", value: "Alex", updatedAt: 1, pinned: true, keywords: [] },
        {
          key: "timezone",
          value: "Europe/Moscow",
          updatedAt: 2,
          pinned: true,
          keywords: [],
        },
      ],
    });
    expect(empty.stablePrefix).toBe(filled.stablePrefix);
    expect(empty.tail).not.toBe(filled.tail);
  });

  it("threads userMessage through the profile gate to reveal contextual facts", () => {
    const facts = [
      { key: "language", value: "ru", updatedAt: 1, pinned: true, keywords: [] },
      {
        key: "deploy_cmd",
        value: "pnpm run deploy",
        updatedAt: 2,
        pinned: false,
        keywords: ["deploy", "release"],
      },
    ];
    const hidden = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      profileFacts: facts,
      userMessage: "hello",
    });
    expect(hidden.tail).toContain("- language: ru");
    expect(hidden.tail).not.toContain("deploy_cmd");

    const revealed = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      profileFacts: facts,
      userMessage: "how do I deploy this branch?",
    });
    expect(revealed.tail).toContain("- deploy_cmd: pnpm run deploy");
    expect(revealed.tail).toContain("- language: ru");
  });

  it("keeps the stable prefix byte-stable across userMessage changes that flip the gate", () => {
    const facts = [
      {
        key: "deploy_cmd",
        value: "pnpm run deploy",
        updatedAt: 1,
        pinned: false,
        keywords: ["deploy"],
      },
    ];
    const a = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      profileFacts: facts,
      userMessage: "hello",
    });
    const b = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      profileFacts: facts,
      userMessage: "deploy this please",
    });
    expect(a.stablePrefix).toBe(b.stablePrefix);
    expect(a.tail).not.toBe(b.tail);
  });

  it("truncates a giant profile under profileMaxTokens", () => {
    const giantValue = "x".repeat(20_000);
    const prompt = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      profileFacts: [
        { key: "blob", value: giantValue, updatedAt: 1, pinned: true, keywords: [] },
      ],
      profileMaxTokens: 50,
    });
    expect(prompt.tail).toContain("### profile");
    expect(prompt.tail).toContain("[truncated]");
    expect(prompt.tokens.profile).toBeLessThanOrEqual(50);
    expect(prompt.truncation.profile).toBe(true);
    expect(prompt.truncated).toBe(true);
  });
});

describe("buildPrompt recalled and memory-index sections", () => {
  it("omits both sections when session has no recalledNotes / memoryIndex", () => {
    const prompt = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    expect(prompt.tail).not.toContain("### recalled");
    expect(prompt.tail).not.toContain("### memory-index");
    expect(prompt.tokens.recalled).toBe(0);
    expect(prompt.tokens.memoryIndex).toBe(0);
  });

  it("renders recalled notes before ### world when present", () => {
    const prompt = buildPrompt({
      session: mkSession({
        recalledNotes: [
          {
            id: 42,
            content: "user prefers Lisbon in October",
            tags: ["trip"],
            metadata: null,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    expect(prompt.tail).toContain("### recalled");
    expect(prompt.tail).toContain("#42");
    expect(prompt.tail).toContain("user prefers Lisbon");
    const recalledIdx = prompt.tail.indexOf("### recalled");
    const worldIdx = prompt.tail.indexOf("### world");
    expect(recalledIdx).toBeLessThan(worldIdx);
    expect(recalledIdx).toBeGreaterThan(-1);
  });

  it("renders memory-index before session-facts, recalled, and world", () => {
    const prompt = buildPrompt({
      session: mkSession({
        knownFacts: [{ text: "one fact" }],
        recalledNotes: [
          {
            id: 1,
            content: "top note",
            tags: [],
            metadata: null,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        memoryIndex: [
          { id: 7, preview: "older convention", tags: ["conv"], updatedAt: 2 },
        ],
      }),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    const indexIdx = prompt.tail.indexOf("### memory-index");
    const factsIdx = prompt.tail.indexOf("### session-facts");
    const recalledIdx = prompt.tail.indexOf("### recalled");
    const worldIdx = prompt.tail.indexOf("### world");
    expect(indexIdx).toBeGreaterThan(-1);
    expect(factsIdx).toBeGreaterThan(-1);
    expect(recalledIdx).toBeGreaterThan(-1);
    expect(factsIdx).toBeGreaterThan(indexIdx);
    expect(recalledIdx).toBeGreaterThan(factsIdx);
    expect(worldIdx).toBeGreaterThan(recalledIdx);
    expect(prompt.tail).toContain("#7");
    expect(prompt.tail).toContain("older convention");
  });

  it("keeps the stable prefix byte-stable across recalled/index changes", () => {
    const base = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    const filled = buildPrompt({
      session: mkSession({
        recalledNotes: [
          {
            id: 1,
            content: "fresh note",
            tags: [],
            metadata: null,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        memoryIndex: [{ id: 2, preview: "pointer", tags: [], updatedAt: 2 }],
      }),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    expect(filled.stablePrefix).toBe(base.stablePrefix);
    expect(filled.tail).not.toBe(base.tail);
  });

  it("truncates a giant recalled note under recallMaxTokens", () => {
    const giant = "x".repeat(20_000);
    const prompt = buildPrompt({
      session: mkSession({
        recalledNotes: [
          {
            id: 1,
            content: giant,
            tags: [],
            metadata: null,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      recallMaxTokens: 40,
      recallPreviewChars: 20_000,
    });
    expect(prompt.tail).toContain("### recalled");
    expect(prompt.tokens.recalled).toBeLessThanOrEqual(40);
    expect(prompt.truncation.recalled).toBe(true);
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
