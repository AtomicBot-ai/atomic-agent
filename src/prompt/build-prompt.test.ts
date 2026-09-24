import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import { resetConfigCache } from "../config/index.js";
import {
  GEMMA4_THINK_PROFILE,
  PLAIN_INSTRUCT_PROFILE,
  QWEN_THINK_PROFILE,
} from "../llm/model-profile.js";
import { buildPrompt } from "./build-prompt.js";
import { FUSION_GUIDANCE } from "./fusion-guidance.js";
import { DEFAULT_TOOL_DESCRIPTORS } from "./tool-descriptors.js";
import { createEmptySessionState } from "../session/session-state.js";
import type { SessionState } from "../session/session-state.js";
import type {
  CapabilitiesSummary,
  SkillCatalogEntry,
  ToolDescriptor,
} from "./stable-prefix.js";
import { estimateTokens, truncateToTokens } from "./token-budget.js";
import { ALSO_AVAILABLE_VIA_TOOL_VIEW } from "./stable-prefix.js";
import {
  REQUEST_FOLLOW_UP_MARKER,
  REQUEST_SECTION_CHAR_BUDGET,
  requestInView,
} from "./request-section.js";

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
  it("renders `### lessons` after `### conversation`, with `### profile` (phase 5)", () => {
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
    // Section order: memory-index is fixed for the turn and sits ahead
    // of the conversation; lessons can change within a turn and follow
    // it. Both must follow the stable prefix.
    const lessonsIdx = text.indexOf("\n### lessons\n");
    const indexIdx = text.indexOf("\n### memory-index\n");
    const conversationIdx = text.indexOf("\n### conversation\n");
    expect(indexIdx).toBeGreaterThan(0);
    expect(conversationIdx).toBeGreaterThan(indexIdx);
    expect(lessonsIdx).toBeGreaterThan(conversationIdx);
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

  it("carries the ### fusion block exactly when fusion.delegate is in the catalog", () => {
    // The block is stable-prefix content, so its presence is decided by
    // the descriptor list and nothing else. Absent, the prefix must be
    // byte-identical to a build that never had the feature -- which is
    // what the KV cache of every non-fusion install depends on.
    const session = mkSession();
    const without = buildPrompt({
      session,
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    expect(without.text).not.toContain("### fusion");

    const withFusion = buildPrompt({
      session,
      toolDescriptors: [
        ...TOOLS,
        {
          name: "fusion.delegate",
          summary: "Delegate to local workers.",
          argsSchema: "{ tasks: [] }",
        },
      ],
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    expect(withFusion.text).toContain("### fusion");
    expect(withFusion.text).toContain(FUSION_GUIDANCE);
    expect(withFusion.text.indexOf("### fusion")).toBeLessThan(
      withFusion.text.indexOf("### instructions"),
    );
  });

  it("appends a Windows platform hint to the stable prefix only on win32 capabilities", () => {
    const session = mkSession();
    const darwin = buildPrompt({
      session,
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    const windows = buildPrompt({
      session,
      toolDescriptors: TOOLS,
      capabilities: { ...CAPS, platform: "win32" },
      skillCatalog: SKILLS,
    });
    expect(darwin.stablePrefix).not.toContain("Windows environment:");
    expect(windows.stablePrefix).toContain("Windows environment:");
    expect(windows.stablePrefix).toContain("findstr");
    expect(windows.stablePrefix).toContain("%VAR%");
    // The Windows hint changes the stable prefix deterministically by
    // platform — the two hashes differ but each is stable per platform.
    expect(windows.stablePrefix).not.toBe(darwin.stablePrefix);
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

  it("frequent-tool summaries send source files to os.fs.read, not read_document", () => {
    // Issue #113: the stable prefix is where a model decides between the
    // two readers, and it ships on every turn. Pinning the wording here
    // (against the real descriptors, not the stub TOOLS above) keeps a
    // future summary edit from quietly dropping the routing hint that
    // stops models bouncing off read_document's unsupported-extension
    // error on `.py` / `.ts` files.
    const prompt = buildPrompt({
      session: mkSession(),
      toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    expect(prompt.stablePrefix).toContain(
      "the default for source code and text files",
    );
    expect(prompt.stablePrefix).toContain(
      "NOT for source code: use os.fs.read",
    );
    // The summary must not claim read_document rejects text files — it
    // extracts .txt/.md/.csv as `plain`, and a summary that contradicts the
    // tool re-creates the very ambiguity this change removes.
    expect(prompt.stablePrefix).not.toContain(
      "NOT for source code or text files",
    );
    // The bad guess in issue #113 was `format: "text"`. The stable prefix
    // carries the closed set so the guess is never reachable.
    expect(prompt.stablePrefix).toContain(
      "format?: 'pdf' | 'docx' | 'doc' | 'xlsx' | 'rtf' | 'odt' | 'pptx' | 'plain'",
    );
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
    expect(prompt.stablePrefix).toContain(
      "Emit a JSON ARRAY of tool calls now",
    );
    expect(prompt.stablePrefix).toContain(
      "Always start with `[` and end with `]`",
    );
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

  it("pins the bare-value final-answer discipline in the persona stable prefix", () => {
    const prompt = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    // When an exact format/marker is requested, `reply` must be the bare
    // value only — no preamble/essay. Recovers GAIA `FINAL ANSWER:` tasks.
    expect(prompt.stablePrefix).toContain("the `reply` text MUST be ONLY that");
    expect(prompt.stablePrefix).toContain(
      "emit exactly that line as the entire reply",
    );
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
    expect(
      prompt.stablePrefix.startsWith("<|turn>system\n<|think|>\n### system"),
    ).toBe(true);
    // Prompt ends at the model-turn opener — NOT a prefilled channel block
    // (a prefilled `<|channel>thought\n` reads as thinking-disabled on Gemma).
    expect(prompt.tail.endsWith("<turn|>\n<|turn>model\n")).toBe(true);
    expect(prompt.tail).not.toContain("<|channel>thought");
  });

  it("suppressReasoningPrefill drops the qwen think prefill (chat transports, issue #283)", () => {
    const prompt = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      profile: QWEN_THINK_PROFILE,
      suppressReasoningPrefill: true,
    });
    // The prompt must NOT ship a literal `<think>` to a chat endpoint —
    // Ollama Cloud corrupts the string server-side (ollama/ollama#17248).
    expect(prompt.tail.endsWith("<think>\n")).toBe(false);
    expect(prompt.tail).not.toContain("<think>");
    // The emit anchor stays the last directive before generation.
    expect(prompt.tail.trimEnd().endsWith("Respond now.")).toBe(true);
  });

  it("suppressReasoningPrefill drops the gemma turn framing and system token (issue #283)", () => {
    const prompt = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      profile: GEMMA4_THINK_PROFILE,
      suppressReasoningPrefill: true,
    });
    expect(prompt.tail.endsWith("<turn|>\n<|turn>model\n")).toBe(false);
    expect(prompt.tail).not.toContain("<|turn>");
    expect(prompt.stablePrefix).not.toContain("<|turn>system");
    expect(prompt.stablePrefix).not.toContain("<|think|>");
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

  describe("thinking: off on the built prompt (F49)", () => {
    it("ends a qwen prompt with the template's own disabled marker instead of the open tag", () => {
      const prompt = buildPrompt({
        session: mkSession(),
        toolDescriptors: TOOLS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        profile: QWEN_THINK_PROFILE,
        thinking: "off",
      });
      expect(prompt.tail.endsWith("<think>\n\n</think>\n\n")).toBe(true);
      expect(
        prompt.tail.endsWith("Respond now.\n\n<think>\n\n</think>\n\n"),
      ).toBe(true);
      // Exactly one think block, the closed one: no open prefill after it.
      expect(prompt.tail.match(/<think>/g)).toHaveLength(1);
      // The stable prefix is untouched — the switch is tail bytes only.
      const on = buildPrompt({
        session: mkSession(),
        toolDescriptors: TOOLS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        profile: QWEN_THINK_PROFILE,
        thinking: "on",
      });
      expect(on.stablePrefix).toBe(prompt.stablePrefix);
    });

    it("on and auto keep the open-tag prefill", () => {
      for (const thinking of ["on", "auto"] as const) {
        const prompt = buildPrompt({
          session: mkSession(),
          toolDescriptors: TOOLS,
          capabilities: CAPS,
          skillCatalog: SKILLS,
          profile: QWEN_THINK_PROFILE,
          thinking,
        });
        expect(prompt.tail.endsWith("<think>\n"), thinking).toBe(true);
        expect(prompt.tail, thinking).not.toContain("</think>");
      }
    });

    it("leaves gemma's turn framing as it is — its disabled marker is the prefilled channel", () => {
      const prompt = buildPrompt({
        session: mkSession(),
        toolDescriptors: TOOLS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        profile: GEMMA4_THINK_PROFILE,
        thinking: "off",
      });
      expect(prompt.tail.endsWith("<turn|>\n<|turn>model\n")).toBe(true);
      expect(prompt.tail).not.toContain("<|channel>thought");
      expect(prompt.tail).not.toContain("<think>");
    });

    it("is ignored where the prefill is suppressed — a chat endpoint gets no marker either", () => {
      const prompt = buildPrompt({
        session: mkSession(),
        toolDescriptors: TOOLS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        profile: QWEN_THINK_PROFILE,
        thinking: "off",
        suppressReasoningPrefill: true,
      });
      expect(prompt.tail).not.toContain("<think>");
      expect(prompt.tail.trimEnd().endsWith("Respond now.")).toBe(true);
    });
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
        {
          kind: "user" as const,
          text: "the latest important question",
          at: 999,
        },
      ],
    };
    const prompt = buildPrompt({
      session,
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      tokenBudget: 400,
      // This test is about the token axis, as its name says. History is
      // capped on a second, independent axis now — tasks — and the
      // fixture is 31 of them, so opt out of that one to keep measuring
      // the thing under test.
      conversationMaxPairs: 100,
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
    const sessionTok = prompt.tokens.loadedSkills + prompt.tokens.sessionFacts;
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
        {
          kind: "user" as const,
          text: "the latest important question",
          at: 9_999,
        },
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

  it("budgets a Fusion orchestrator against its own window, not the workers'", () => {
    // The shape that shipped 16.9k/16.4k on screen: a 16-slot local
    // daemon reports 262144/16 = 16384 per slot, the orchestrator runs
    // on a 128k cloud model, and one profile is held for both legs.
    const workerProfile = { ...PLAIN_INSTRUCT_PROFILE, contextWindow: 16_384 };
    const orchestrator = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      profile: workerProfile,
      contextWindow: 128_000,
      profileWindowApplies: false,
      completionMaxTokens: 4096,
      conversationMaxTokens: 64_000,
    });
    expect(orchestrator.contextWindow).toBe(128_000);
    expect(orchestrator.conversationCapEffective).toBeGreaterThan(16_384);

    // The worker leg on the same profile still gets the probed window.
    const worker = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      profile: workerProfile,
      contextWindow: 128_000,
      profileWindowApplies: true,
      completionMaxTokens: 4096,
      conversationMaxTokens: 64_000,
    });
    expect(worker.contextWindow).toBe(16_384);
    expect(worker.conversationCapEffective).toBeLessThan(16_384);
  });

  it("keeps the probe authoritative when nothing says otherwise", () => {
    // Every single-leg caller omits the flag, and must keep the old
    // answer: the probe describes the one model in play.
    const prompt = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      profile: { ...PLAIN_INSTRUCT_PROFILE, contextWindow: 8192 },
      contextWindow: 128_000,
      conversationMaxTokens: 64_000,
    });
    expect(prompt.contextWindow).toBe(8192);
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

  describe("the transcript cut is remembered on the session", () => {
    /** A finished task with `steps` tool round-trips of about 60 tokens. */
    function longTask(label: string, steps: number, from: number) {
      const turns: SessionState["turns"] = [
        { kind: "user", text: `ask ${label}`, at: from },
      ];
      for (let i = 0; i < steps; i += 1) {
        turns.push(
          {
            kind: "assistant_tool_call",
            tool: "fs.read",
            args: { path: `/${label}/${i}` },
            at: from + 1 + i * 2,
          },
          {
            kind: "tool_result",
            tool: "fs.read",
            status: "ok",
            summary: `${label}-${i} ${"x".repeat(240)}`,
            truncated: false,
            at: from + 2 + i * 2,
          },
        );
      }
      turns.push({
        kind: "assistant_reply",
        text: `answer ${label}`,
        at: from + 100,
      });
      return turns;
    }
    const history = [
      ...longTask("a", 6, 1_000),
      ...longTask("b", 6, 2_000),
      { kind: "user" as const, text: "ask c", at: 3_000 },
    ];
    const build = (
      session: SessionState,
      extra: Record<string, unknown> = {},
    ) =>
      buildPrompt({
        session,
        toolDescriptors: TOOLS,
        capabilities: CAPS,
        skillCatalog: SKILLS,
        conversationMaxTokens: 800,
        ...extra,
      });

    it("publishes the cut and holds it on the next build while the tail fits", () => {
      const first = build(mkSession({ turns: history }));
      expect(first.droppedTurns).toBeGreaterThan(0);
      const start = first.conversationPackStart;
      expect(start).not.toBeNull();
      expect(start!.index).toBe(first.droppedTurns);

      const grown = mkSession({
        turns: [
          ...history,
          {
            kind: "assistant_tool_call",
            tool: "fs.read",
            args: { path: "/c/0" },
            at: 3_001,
          },
          {
            kind: "tool_result",
            tool: "fs.read",
            status: "ok",
            summary: `c-0 ${"x".repeat(240)}`,
            truncated: false,
            at: 3_002,
          },
        ],
        conversationPackStart: start!,
      });
      const held = build(grown);
      expect(held.conversationPackStart).toEqual(start);
      expect(held.droppedTurns).toBe(first.droppedTurns);
      // The section only grew at its end: the first build's rendering is
      // a prefix of the second's, summary line included.
      const section = (t: string) => {
        const from = t.indexOf("### conversation\n");
        return t.slice(from, t.indexOf("\n\n###", from));
      };
      expect(section(held.tail).startsWith(section(first.tail))).toBe(true);
      // Without the memory the cut would have moved.
      const forgotten = build({ ...grown, conversationPackStart: undefined });
      expect(forgotten.droppedTurns).toBeGreaterThan(held.droppedTurns);
    });

    it("cuts to half the budget for a model with no partial prefix reuse", () => {
      const partial = build(mkSession({ turns: history }), {
        profile: PLAIN_INSTRUCT_PROFILE,
      });
      const none = build(mkSession({ turns: history }), {
        profile: { ...PLAIN_INSTRUCT_PROFILE, prefixReuse: "none" },
      });
      expect(none.droppedTurns).toBeGreaterThan(partial.droppedTurns);
      // An operator's own lower share still wins.
      const lower = build(mkSession({ turns: history }), {
        profile: { ...PLAIN_INSTRUCT_PROFILE, prefixReuse: "none" },
        conversationLowWater: 0.3,
      });
      expect(lower.droppedTurns).toBeGreaterThan(none.droppedTurns);
    });
  });

  it("orders the tail by what can change within a turn: memory-index, session-facts, recalled, world, conversation, then profile, lessons, procedures, loaded-skills, loaded-tools", () => {
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
      recalledLessons: [
        { id: 3, activation: "when", tags: [], workingDir: null, updatedAt: 1 },
      ],
      recalledProcedures: [
        { id: 4, activation: "how", tags: [], workingDir: null, updatedAt: 1 },
      ],
      loadedTools: [
        {
          name: "os.git.show",
          summary: "Show a commit.",
          argsSchema: "{ repo?: string }",
          loadedAt: 1,
          source: "explicit",
        },
      ],
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
    // Fixed for the turn, ahead of the transcript…
    expect(idx("### memory-index")).toBeGreaterThanOrEqual(0);
    expect(idx("### memory-index")).toBeLessThan(idx("### session-facts"));
    expect(idx("### session-facts")).toBeLessThan(idx("### recalled"));
    expect(idx("### recalled")).toBeLessThan(idx("### world"));
    expect(idx("### world")).toBeLessThan(idx("### conversation"));
    // …then what a step can change, so a `tool.view`, a `skill.view` or a
    // profile write lands behind the transcript the model already read
    // instead of ahead of it (a change there re-reads the whole prompt
    // on a model with no partial prefix reuse).
    expect(idx("### conversation")).toBeLessThan(idx("### profile"));
    expect(idx("### profile")).toBeLessThan(idx("### lessons"));
    expect(idx("### lessons")).toBeLessThan(idx("### procedures"));
    expect(idx("### procedures")).toBeLessThan(idx("### loaded-skills"));
    expect(idx("### loaded-skills")).toBeLessThan(idx("### loaded-tools"));
    expect(idx("### loaded-tools")).toBeLessThan(idx("### respond"));
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
      {
        key: "language",
        value: "ru",
        updatedAt: 1,
        pinned: true,
        keywords: [],
      },
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

  it("places ### profile after ### conversation and before optional loaded-skills", () => {
    const prompt = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      profileFacts: [
        {
          key: "language",
          value: "ru",
          updatedAt: 1,
          pinned: true,
          keywords: [],
        },
      ],
    });
    const loadedIdx = prompt.tail.indexOf("### loaded-skills");
    const profileIdx = prompt.tail.indexOf("### profile");
    const conversationIdx = prompt.tail.indexOf("### conversation");
    if (loadedIdx >= 0) {
      expect(profileIdx).toBeLessThan(loadedIdx);
    }
    expect(profileIdx).toBeGreaterThan(conversationIdx);
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
        {
          key: "name",
          value: "Alex",
          updatedAt: 1,
          pinned: true,
          keywords: [],
        },
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
      {
        key: "language",
        value: "ru",
        updatedAt: 1,
        pinned: true,
        keywords: [],
      },
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
        {
          key: "blob",
          value: giantValue,
          updatedAt: 1,
          pinned: true,
          keywords: [],
        },
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

describe("buildPrompt profile clip (issue #407)", () => {
  it("keeps a pinned fact over a contextual one, whole lines only, and reports it", () => {
    const prompt = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      profileFacts: [
        {
          key: "a_deploy",
          value: "x".repeat(100),
          updatedAt: 1,
          pinned: false,
          keywords: ["deploy"],
        },
        {
          key: "z_consent",
          value: "never share the owner's files without asking",
          updatedAt: 1,
          pinned: true,
          keywords: [],
        },
      ],
      userMessage: "deploy now",
      profileMaxTokens: 40,
    });
    const start = prompt.tail.indexOf("### profile\n") + "### profile\n".length;
    const section = prompt.tail.slice(
      start,
      prompt.tail.indexOf("\n\n", start),
    );
    expect(section).toBe(
      [
        "- z_consent: never share the owner's files without asking",
        "… [truncated] 1 more profile fact not shown (memory.profile.maxTokens)",
      ].join("\n"),
    );
    expect(prompt.truncation.profile).toBe(true);
    expect(prompt.profileClip).toEqual({
      rendered: 1,
      dropped: 1,
      pinnedDropped: 0,
      maxTokens: 40,
    });
    expect(prompt.tokens.profile).toBeLessThanOrEqual(40);
  });

  it("reports no clip when the profile fits", () => {
    const prompt = buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      profileFacts: [
        {
          key: "language",
          value: "ru",
          updatedAt: 1,
          pinned: true,
          keywords: [],
        },
      ],
    });
    expect(prompt.profileClip).toBeUndefined();
    expect(prompt.truncation.profile).toBe(false);
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

describe("buildPrompt tool transport (issue #285)", () => {
  const base = () => ({
    session: mkSession(),
    toolDescriptors: TOOLS,
    capabilities: CAPS,
    skillCatalog: SKILLS,
  });

  it("native_tools prefix drops the text-JSON emission mandate but keeps the ### tools catalog", () => {
    const native = buildPrompt({ ...base(), toolTransport: "native_tools" });
    // The dual mandate: with an OpenAI `tools` payload on the request,
    // the prompt must not also order text-JSON emission.
    expect(native.stablePrefix).not.toContain(
      "Emit a JSON ARRAY of tool calls now",
    );
    expect(native.stablePrefix).not.toContain(
      "Each step emits exactly one JSON array matching the tool grammar",
    );
    // ...including the `### rules` opener — every text-array mandate
    // must go, not just the persona and `### instructions` ones.
    expect(native.stablePrefix).not.toContain("One tool-call array per step");
    expect(native.stablePrefix).not.toContain(
      "a solo action is a length-1 array",
    );
    // ...and the persona's reply-discipline line ("emit that tool JSON").
    expect(native.stablePrefix).not.toContain("emit that tool JSON");
    expect(native.stablePrefix).toContain("call that tool, not `reply`");
    expect(native.stablePrefix).toContain("### rules");
    expect(native.stablePrefix).toContain("One batch of tool calls per step");
    expect(native.stablePrefix).toContain("native function-calling interface");
    // The catalog stays: a fallback chain can hand this session to a
    // grammar-only link, and the catalog carries tier/tool.view docs.
    expect(native.stablePrefix).toContain("### tools");
    expect(native.stablePrefix).toContain("# common (full)");
    expect(native.stablePrefix).toContain("browser.navigate");
    expect(native.stablePrefix).toContain("### instructions");
  });

  it("grammar prefix is byte-identical whether the transport is omitted or explicit", () => {
    const implicit = buildPrompt(base());
    const explicit = buildPrompt({ ...base(), toolTransport: "grammar" });
    expect(explicit.stablePrefix).toBe(implicit.stablePrefix);
    // And it still carries the legacy text-JSON mandate untouched.
    expect(explicit.stablePrefix).toContain(
      "Emit a JSON ARRAY of tool calls now",
    );
    expect(explicit.stablePrefix).toContain(
      "Each step emits exactly one JSON array matching the tool grammar",
    );
    expect(explicit.stablePrefix).toContain(
      "One tool-call array per step (including `skill.view`); a solo action is a length-1 array. Destructive or privileged tools may require user approval.",
    );
  });

  it("stable prefix stays byte-stable across turns for a fixed transport", () => {
    const turn1 = buildPrompt({ ...base(), toolTransport: "native_tools" });
    const turn2 = buildPrompt({
      ...base(),
      session: mkSession({
        turns: [
          { kind: "user", text: "Check inbox", at: 1 },
          { kind: "assistant_reply", text: "Done", at: 2 },
          { kind: "user", text: "Now archive it", at: 3 },
        ],
      }),
      toolTransport: "native_tools",
    });
    expect(turn2.stablePrefix).toBe(turn1.stablePrefix);
  });

  it("an explicit systemPersona override wins on both transports", () => {
    const persona = "You are a test persona.";
    const native = buildPrompt({
      ...base(),
      systemPersona: persona,
      toolTransport: "native_tools",
    });
    const grammar = buildPrompt({ ...base(), systemPersona: persona });
    expect(native.stablePrefix).toContain(persona);
    expect(grammar.stablePrefix).toContain(persona);
  });
});

describe("buildPrompt tool roles (F18)", () => {
  const build = (
    toolRole: "builder" | "orchestrator" | "full" | undefined,
    session = mkSession(),
  ) =>
    buildPrompt({
      session,
      toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      ...(toolRole !== undefined ? { toolRole } : {}),
    });

  it("full and no role are byte-identical — the pre-role prefix, KV cache intact", () => {
    expect(build("full").stablePrefix).toBe(build(undefined).stablePrefix);
    expect(build(undefined).stablePrefix).not.toContain(
      ALSO_AVAILABLE_VIA_TOOL_VIEW,
    );
  });

  it("builder: build tools in full, the rest as one line of names", () => {
    const { stablePrefix } = build("builder");
    expect(stablePrefix).toContain("- os.fs.write —");
    expect(stablePrefix).toContain("- os.shell.run —");
    expect(stablePrefix).toContain("- reply —");
    expect(stablePrefix).not.toContain("- tasks.schedule —");
    expect(stablePrefix).not.toContain("- browser.navigate —");
    const line = stablePrefix
      .split("\n")
      .find((l) => l.startsWith(ALSO_AVAILABLE_VIA_TOOL_VIEW));
    expect(line).toBeDefined();
    expect(line).toContain("tasks.schedule");
    expect(line).toContain("browser.navigate");
    expect(line).toContain("finish");
    expect(line).not.toContain("os.fs.write");
    // Exactly one such line, and it sits inside `### tools`.
    expect(stablePrefix.split(ALSO_AVAILABLE_VIA_TOOL_VIEW)).toHaveLength(2);
    expect(stablePrefix.indexOf(ALSO_AVAILABLE_VIA_TOOL_VIEW)).toBeGreaterThan(
      stablePrefix.indexOf("### tools"),
    );
    expect(stablePrefix.indexOf(ALSO_AVAILABLE_VIA_TOOL_VIEW)).toBeLessThan(
      stablePrefix.indexOf("### capabilities"),
    );
  });

  it("orchestrator: no build tool in full; the write tools are names only", () => {
    const { stablePrefix } = build("orchestrator");
    expect(stablePrefix).toContain("- os.fs.read —");
    expect(stablePrefix).toContain("- finish —");
    expect(stablePrefix).not.toContain("- os.fs.write —");
    expect(stablePrefix).not.toContain("- os.shell.run —");
    const line = stablePrefix
      .split("\n")
      .find((l) => l.startsWith(ALSO_AVAILABLE_VIA_TOOL_VIEW))!;
    expect(line).toContain("os.fs.write");
    expect(line).toContain("os.shell.run");
    // Per role, not per turn: two builds under one role are identical,
    // and the two roles differ from each other.
    expect(build("orchestrator").stablePrefix).toBe(stablePrefix);
    expect(build("builder").stablePrefix).not.toBe(stablePrefix);
  });

  it("renders a loaded out-of-role tool in the tail, and skips one the prefix already describes in full", () => {
    const loaded = mkSession({
      loadedTools: [
        {
          name: "os.fs.write",
          summary: "Write a file (loaded).",
          argsSchema: "{ path: string, content: string }",
          loadedAt: 1,
          source: "explicit",
        },
        {
          name: "os.git.show",
          summary: "Show a commit.",
          argsSchema: "{ repo?: string, revision?: string }",
          loadedAt: 2,
          source: "explicit",
        },
      ],
    });
    // Orchestrator: `os.fs.write` is outside the role, so the loaded copy
    // is what describes it — it must render.
    const orchestrator = build("orchestrator", loaded);
    expect(orchestrator.tail).toContain("### loaded-tools");
    expect(orchestrator.tail).toContain("Write a file (loaded).");
    expect(orchestrator.tail).toContain("os.git.show");
    // Full: the prefix already has `os.fs.write` in full; only the rare
    // tool is worth a tail entry.
    const full = build("full", loaded);
    expect(full.tail).toContain("### loaded-tools");
    expect(full.tail).not.toContain("Write a file (loaded).");
    expect(full.tail).toContain("os.git.show");
  });
});

describe("buildPrompt structured form (`messages`)", () => {
  it("exposes the stable prefix, the packed turns and the tail without `### conversation`", () => {
    const base = mkSession();
    const prompt = buildPrompt({
      session: {
        ...base,
        turns: [
          ...base.turns,
          {
            kind: "assistant_tool_call",
            tool: "browser.read_aria",
            args: { x: 1 },
            at: 1,
          },
          {
            kind: "tool_result",
            tool: "browser.read_aria",
            status: "error",
            summary: "timed out waiting for page",
            truncated: true,
            at: 2,
          },
        ],
      },
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      transientNotice: "be brief",
      currentDate: "2026-09-14",
      toolTransport: "native_tools",
      suppressReasoningPrefill: true,
    });
    expect(prompt.messages.system).toBe(prompt.stablePrefix);
    expect(prompt.messages.droppedSummary).toBeNull();
    expect(prompt.messages.turns).toEqual([
      { kind: "user", text: "Check inbox" },
      {
        kind: "assistant_tool_call",
        tool: "browser.read_aria",
        args: { x: 1 },
      },
      {
        kind: "tool_result",
        tool: "browser.read_aria",
        status: "error",
        body: "timed out waiting for page",
        truncated: true,
      },
    ]);
    const { tail } = prompt.messages;
    expect(tail).not.toContain("### conversation");
    expect(tail).not.toContain("assistant_tool_call:");
    expect(tail).toContain("### world");
    expect(tail).toContain("### notice\nbe brief");
    expect(tail).toContain("CURRENT DATE: 2026-09-14");
    expect(tail.trimEnd().endsWith("### respond\nRespond now.")).toBe(true);
    // The flat tail is the same halves with the conversation between them.
    const [before, after] =
      tail.split("### task-policy").length > 1
        ? [
            tail.slice(0, tail.indexOf("### task-policy")),
            tail.slice(tail.indexOf("### task-policy")),
          ]
        : [
            tail.slice(0, tail.indexOf("### notice")),
            tail.slice(tail.indexOf("### notice")),
          ];
    expect(prompt.tail.startsWith(before)).toBe(true);
    expect(prompt.tail.endsWith(after)).toBe(true);
    expect(prompt.tail).toContain("### conversation");
  });

  it("carries the dropped-turns recap separately from the turns", () => {
    const turns = Array.from({ length: 40 }, (_, i) =>
      i % 2 === 0
        ? {
            kind: "user" as const,
            text: `message ${i} ${"x".repeat(200)}`,
            at: i,
          }
        : {
            kind: "assistant_reply" as const,
            text: `reply ${i} ${"y".repeat(200)}`,
            at: i,
          },
    );
    const prompt = buildPrompt({
      session: mkSession({ turns }),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      conversationMaxTokens: 400,
    });
    expect(prompt.droppedTurns).toBeGreaterThan(0);
    expect(prompt.messages.droppedSummary).toBe(
      prompt.tail
        .slice(
          prompt.tail.indexOf("### conversation\n") +
            "### conversation\n".length,
        )
        .split("\n")[0],
    );
    expect(prompt.messages.turns.length).toBe(
      turns.length - prompt.droppedTurns,
    );
  });
});

describe("### request pins the operator's request once its carrier is dropped (F22)", () => {
  const SPEC = `Build the asteroids game: ${"spec ".repeat(600)}`.trim();

  function repairSession(): SessionState {
    // A long first turn (the spec), a wall of tool traffic, then the
    // repair message that starts the current turn. Under a small cap the
    // packer keeps the last user turn and drops the spec's.
    const turns: SessionState["turns"] = [{ kind: "user", text: SPEC, at: 1 }];
    for (let i = 0; i < 60; i += 1) {
      turns.push({
        kind: "assistant_tool_call",
        tool: "os.fs.read",
        args: { path: `f${i}` },
        at: 2 + i,
      });
      turns.push({
        kind: "tool_result",
        tool: "os.fs.read",
        status: "ok",
        summary: `${"x".repeat(120)} ${i}`,
        at: 2 + i,
      });
    }
    turns.push({ kind: "assistant_reply", text: "built", at: 100 });
    turns.push({ kind: "user", text: "fix these bugs", at: 101 });
    return { ...mkSession(), turns };
  }

  const base = {
    toolDescriptors: TOOLS,
    capabilities: CAPS,
    skillCatalog: SKILLS,
  };

  it("renders the section immediately before ### conversation only when the carrier was dropped", () => {
    const dropped = buildPrompt({
      ...base,
      session: repairSession(),
      conversationMaxTokens: 600,
      originalRequest: SPEC,
    });
    expect(dropped.droppedTurns).toBeGreaterThan(0);
    const tail = dropped.tail;
    const world = tail.indexOf("### world");
    const request = tail.indexOf("### request");
    const conversation = tail.indexOf("### conversation");
    expect(request).toBeGreaterThan(world);
    expect(conversation).toBeGreaterThan(request);
    expect(tail.slice(request, conversation)).toContain(
      "Build the asteroids game",
    );
    expect(tail.slice(request, conversation)).toContain(
      "has been dropped from the conversation below",
    );
    // Its room came out of the conversation cap: the tail still fits.
    expect(dropped.tokens.conversation).toBeLessThanOrEqual(
      dropped.conversationCapEffective,
    );

    const inView = buildPrompt({
      ...base,
      session: repairSession(),
      conversationMaxTokens: 32_000,
      originalRequest: SPEC,
    });
    expect(inView.droppedTurns).toBe(0);
    expect(inView.tail).not.toContain("### request");
    // The section is rendered from the record, not from the transcript,
    // so a dropped carrier and no record costs nothing either.
    expect(
      buildPrompt({
        ...base,
        session: repairSession(),
        conversationMaxTokens: 600,
      }).tail,
    ).not.toContain("### request");
  });

  it("reads a follow-up record by the turn it was taken from", () => {
    // `pickOriginalRequest` combines the previous message with a short
    // follow-up; the carrier to look for is the previous message.
    const combined = `${SPEC}\n\n${REQUEST_FOLLOW_UP_MARKER}\nfix these bugs`;
    const dropped = buildPrompt({
      ...base,
      session: repairSession(),
      conversationMaxTokens: 600,
      originalRequest: combined,
    });
    expect(dropped.tail).toContain("### request");
    const inView = buildPrompt({
      ...base,
      session: repairSession(),
      conversationMaxTokens: 32_000,
      originalRequest: combined,
    });
    expect(inView.tail).not.toContain("### request");
  });

  it("clips the section at 16,000 chars and says so", () => {
    const long = "L".repeat(REQUEST_SECTION_CHAR_BUDGET + 500);
    const prompt = buildPrompt({
      ...base,
      session: repairSession(),
      conversationMaxTokens: 600,
      originalRequest: long,
    });
    const section = prompt.tail.slice(
      prompt.tail.indexOf("### request"),
      prompt.tail.indexOf("### conversation"),
    );
    expect(section).toContain("L".repeat(REQUEST_SECTION_CHAR_BUDGET));
    expect(section).not.toContain("L".repeat(REQUEST_SECTION_CHAR_BUDGET + 1));
    expect(section).toContain("truncated: the request is 16,500 chars");
  });

  it("requestInView matches the carrier by its trimmed text", () => {
    const turns: SessionState["turns"] = [
      { kind: "user", text: "  hello  ", at: 1 },
    ];
    expect(requestInView("hello", turns)).toBe(true);
    expect(requestInView("other", turns)).toBe(false);
    expect(requestInView("   ", turns)).toBe(true);
    expect(
      requestInView(`hello\n\n${REQUEST_FOLLOW_UP_MARKER}\ncontinue`, turns),
    ).toBe(true);
    expect(
      requestInView(`other\n\n${REQUEST_FOLLOW_UP_MARKER}\nhello`, turns),
    ).toBe(false);
  });
});

describe("buildPrompt profile vote filter", () => {
  const stateDir = process.env.ATOMIC_AGENT_STATE_DIR;
  afterEach(() => {
    if (stateDir === undefined) delete process.env.ATOMIC_AGENT_STATE_DIR;
    else process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
  });

  const facts = [
    {
      key: "language",
      value: "ru",
      updatedAt: 1,
      pinned: true,
      keywords: [],
      voteScore: 0,
    },
    {
      key: "stale_rule",
      value: "always answer in French",
      updatedAt: 2,
      pinned: true,
      keywords: [],
      voteScore: -3,
    },
  ];

  function build(profileFilterThreshold?: number) {
    return buildPrompt({
      session: mkSession(),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
      profileFacts: facts,
      ...(profileFilterThreshold !== undefined
        ? { profileFilterThreshold }
        : {}),
    });
  }

  function useConfig(threshold: number): void {
    const dir = mkdtempSync(join(tmpdir(), "profile-vote-filter-"));
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({
        memory: { voting: { profileFilterThreshold: threshold } },
      }),
    );
    process.env.ATOMIC_AGENT_STATE_DIR = dir;
    resetConfigCache();
  }

  it("hides a downvoted pinned fact at the configured threshold", () => {
    useConfig(3);
    const prompt = build();
    expect(prompt.tail).toContain("- language: ru");
    expect(prompt.tail).not.toContain("stale_rule");
  });

  it("keeps a fact whose score has not reached the configured threshold", () => {
    useConfig(5);
    expect(build().tail).toContain("- stale_rule: always answer in French");
  });

  it("an explicit threshold of 0 disables the filter", () => {
    useConfig(3);
    expect(build(0).tail).toContain("- stale_rule: always answer in French");
  });
});
