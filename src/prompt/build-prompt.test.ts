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
    argsSchema: "{ url: string }",
  },
  {
    name: "finish",
    summary: "Signal goal completion.",
    argsSchema: "{ summary: string }",
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
  it("renders `### lessons` between `### profile` and `### memory-index` (phase 5)", () => {
    const session = mkSession({
      profileFacts: [],
      recalledLessons: [
        {
          id: 42,
          activation: "When asked about pnpm packages",
          tags: ["tool"],
          workingDir: null,
          updatedAt: 1,
        },
      ],
      memoryIndex: [
        {
          id: 7,
          preview: "older episode",
          tags: [],
          updatedAt: 1,
          workingDir: null,
          sessionId: null,
        },
      ],
    });
    const { text } = buildPrompt({
      session,
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    expect(text).toMatch(/\n### lessons\n/);
    expect(text).toContain("*42 [tool] When asked about pnpm packages");
    // Section order: lessons tail header must precede the
    // memory-index tail header, both must follow the stable prefix.
    const lessonsIdx = text.indexOf("\n### lessons\n");
    const indexIdx = text.indexOf("\n### memory-index\n");
    expect(lessonsIdx).toBeGreaterThan(0);
    expect(indexIdx).toBeGreaterThan(lessonsIdx);
  });

  it("omits the `### lessons` tail block when `recalledLessons` is undefined or empty (phase 5)", () => {
    const session = mkSession({ recalledLessons: [] });
    const { text } = buildPrompt({
      session,
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    // The persona mentions `### lessons` once in the stable prefix
    // (KV-cache change #1). The variable tail header `\n### lessons\n`
    // must be absent when nothing is surfaced.
    expect(text).not.toMatch(/\n### lessons\n/);
  });

  it("mentions `### lessons` in the persona stable prefix (KV-cache change #1)", () => {
    const session = mkSession();
    const { stablePrefix } = buildPrompt({
      session,
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    // Phase 5 ships the first of two planned stable-prefix bumps for
    // memory-v2. AGENTS.md "Memory fabric phase 5" documents the
    // one-time KV-cache invalidation. The string below is the
    // canary — moving it requires bumping the snapshot test in
    // `stable-prefix.test.ts` and announcing the cache flush.
    expect(stablePrefix).toContain("### lessons");
  });

  it("renders `currentDate` in the variable tail just before `### respond`", () => {
    const { stablePrefix, tail, text } = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      currentDate: "2026-06-09 (Tuesday)",
    });
    expect(tail).toContain(
      "CURRENT DATE: 2026-06-09 (Tuesday) — this is today.",
    );
    // The date must live in the tail, NOT the stable prefix (KV-cache).
    expect(stablePrefix).not.toContain("CURRENT DATE:");
    // It must sit immediately before the respond anchor.
    const dateIdx = text.indexOf("CURRENT DATE:");
    const respondIdx = text.indexOf("### respond");
    expect(dateIdx).toBeGreaterThan(0);
    expect(respondIdx).toBeGreaterThan(dateIdx);
  });

  it("omits the date line when `currentDate` is not provided, leaving the prefix byte-stable", () => {
    const withDate = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      currentDate: "2026-06-09 (Tuesday)",
    });
    const withoutDate = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    expect(withoutDate.text).not.toContain("CURRENT DATE:");
    // Date is tail-only, so the stable prefix is identical either way.
    expect(withDate.stablePrefix).toBe(withoutDate.stablePrefix);
    expect(withDate.tail).not.toBe(withoutDate.tail);
  });

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

  it("persona steers user file deletion to os.fs.trash instead of shell rm", () => {
    const prompt = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    expect(prompt.stablePrefix).toContain("os.fs.trash");
    expect(prompt.stablePrefix).toContain("Do not use `os.shell.run`");
  });

  it("persona and rules nudge large-dir PDF workflows toward narrow list/glob then read_document", () => {
    const prompt = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    expect(prompt.stablePrefix).toContain("Large directories:");
    expect(prompt.stablePrefix).toContain("Large trees:");
    expect(prompt.stablePrefix).toContain("os.fs.read_document");
  });

  it("stable prefix changes deterministically when a skill is removed from the catalog (skills.disabled)", () => {
    // Pins the contract for the `skills.disabled` denylist: the
    // `SkillRegistry` filters disabled skills out of `list()`, the
    // filtered list feeds `buildSkillCatalog` which feeds the stable
    // prefix. Therefore disabling a skill invalidates KV-cache exactly
    // once (prefix bytes change) and stays stable thereafter
    // (subsequent identical inputs produce identical bytes).
    const withSkill = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    const withoutSkill = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: [],
    });
    expect(withSkill.stablePrefix).not.toBe(withoutSkill.stablePrefix);
    expect(withSkill.stablePrefix).toContain("check-gmail-inbox");
    expect(withoutSkill.stablePrefix).not.toContain("check-gmail-inbox");
    // Reapplying the same input twice yields byte-identical bytes —
    // the cache is invalidated only once on the toggle, not on every
    // step.
    const replay = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: [],
    });
    expect(replay.stablePrefix).toBe(withoutSkill.stablePrefix);
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

  it("pins the array-only tool-call instruction in the stable prefix (KV-cache hygiene)", () => {
    const prompt = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    expect(prompt.stablePrefix).toContain("### instructions");
    // Array-only contract — every emission starts with `[`. This is
    // load-bearing: the GBNF root collapsed to `tool-call-array` to
    // beat the first-token bias.
    expect(prompt.stablePrefix).toContain("Emit a JSON ARRAY of tool calls now");
    expect(prompt.stablePrefix).toContain("Always start with `[` and end with `]`");
    expect(prompt.stablePrefix).toContain(
      "Use `reply` for natural-language answers to the user.",
    );
    // Batch parallel-tool-call hint must be in the stable prefix so
    // the model sees it on every step (and the cache stays warm).
    expect(prompt.stablePrefix).toContain("PARALLEL:");
    expect(prompt.stablePrefix).toContain(
      "put up to 8 calls in the SAME array",
    );
    expect(prompt.stablePrefix).not.toContain("one JSON object");
    expect(prompt.stablePrefix).not.toContain("One tool JSON per step");
    // Concrete worked examples anchor the array shape so the model
    // does not invent a different schema.
    expect(prompt.stablePrefix).toContain(
      '[{"tool":"os.fs.read","args":{"path":"a.ts"}}]',
    );
    expect(prompt.stablePrefix).toContain(
      '[{"tool":"os.fs.read","args":{"path":"a.csv"}}',
    );
    expect(prompt.stablePrefix).toContain(
      "Keep a call solo (length-1 array) when:",
    );
    expect(prompt.tail).not.toContain("### response");
    expect(prompt.tail).not.toContain("Emit a JSON ARRAY of tool calls now");
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

  it("turn-frames the gemma prompt: think token at the top of the system turn, model-turn opener at the end", () => {
    const prompt = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      profile: GEMMA4_THINK_PROFILE,
    });
    // System turn opens first with the reasoning token at the very top.
    expect(prompt.stablePrefix.startsWith("<|turn>system\n<|think|>\n### system")).toBe(
      true,
    );
    // Prompt ends at the model-turn opener — NOT a prefilled channel block
    // (a prefilled `<|channel>thought\n` reads as thinking-disabled on Gemma).
    expect(prompt.tail.endsWith("<turn|>\n<|turn>model\n")).toBe(true);
    expect(prompt.tail).not.toContain("<|channel>thought");
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
    expect(prompt.stablePrefix).toContain("# common (full)");
    expect(prompt.stablePrefix).toContain("- browser.navigate");
    expect(prompt.stablePrefix).toContain("args:");
    expect(prompt.stablePrefix).toContain("browser: chrome");
    expect(prompt.stablePrefix).toContain("check-gmail-inbox");
  });

  it("renders ### loaded-tools when session.loadedTools is non-empty", () => {
    const prompt = buildPrompt({
      session: mkSession({
        loadedTools: [
          {
            name: "os.git.show",
            summary: "Show a commit.",
            argsSchema: "{ repo?: string, revision?: string }",
            loadedAt: 1,
            source: "explicit",
          },
        ],
      }),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    expect(prompt.tail).toContain("### loaded-tools");
    expect(prompt.tail).toContain("os.git.show");
    expect(prompt.tokens.loadedTools).toBeGreaterThan(0);
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

  it("renders a task policy for code and debug work without changing the stable prefix", () => {
    const base = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    const codeTask = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      userMessage: "update src/cart.ts and add focused tests",
    });
    expect(codeTask.stablePrefix).toBe(base.stablePrefix);
    expect(codeTask.tail).toContain("### task-policy");
    expect(codeTask.tail).toContain("kind: code_edit");
    expect(codeTask.tail).toContain("Inspect relevant files");
    expect(codeTask.tail).toContain("Final check before `reply`");
    expect(codeTask.tokens.taskPolicy).toBeGreaterThan(0);
  });

  it("omits task policy for simple answer prompts", () => {
    const prompt = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      userMessage: "what is 2 plus 2?",
    });
    expect(prompt.tail).not.toContain("### task-policy");
    expect(prompt.tokens.taskPolicy).toBe(0);
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
