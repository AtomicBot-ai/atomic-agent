import { describe, expect, it } from "vitest";

import {
  REFLECTION_MESSAGE_CHAR_CAP,
  REFLECTION_STABLE_PREFIX,
  REFLECTION_STABLE_PREFIX_TYPED,
  buildReflectionPrompt,
} from "./reflection-prompt.js";

describe("buildReflectionPrompt", () => {
  it("keeps the stable prefix byte-identical across calls", () => {
    const a = buildReflectionPrompt({
      userMessage: "hi",
      assistantReply: "hello",
    });
    const b = buildReflectionPrompt({
      userMessage: "another turn",
      assistantReply: "different reply",
    });
    expect(a.startsWith(REFLECTION_STABLE_PREFIX)).toBe(true);
    expect(b.startsWith(REFLECTION_STABLE_PREFIX)).toBe(true);
    expect(a.slice(0, REFLECTION_STABLE_PREFIX.length)).toEqual(
      b.slice(0, REFLECTION_STABLE_PREFIX.length),
    );
  });

  it("injects the USER and ASSISTANT messages into the tail", () => {
    const prompt = buildReflectionPrompt({
      userMessage: "I live in Lisbon",
      assistantReply: "Noted, I'll remember that.",
    });
    expect(prompt).toContain("USER: I live in Lisbon");
    expect(prompt).toContain("ASSISTANT: Noted, I'll remember that.");
    expect(prompt.endsWith("### output\n")).toBe(true);
  });

  it("collapses whitespace and trims each message", () => {
    const prompt = buildReflectionPrompt({
      userMessage: "  multi\n   line   user   ",
      assistantReply: "tab\treply\nhere",
    });
    expect(prompt).toContain("USER: multi line user");
    expect(prompt).toContain("ASSISTANT: tab reply here");
  });

  it("advertises both SET and NOTE channels in the stable preamble", () => {
    expect(REFLECTION_STABLE_PREFIX).toContain("SET key=value");
    expect(REFLECTION_STABLE_PREFIX).toContain("NOTE body");
    expect(REFLECTION_STABLE_PREFIX).toMatch(/\[tags=a,b,c\]/);
    expect(REFLECTION_STABLE_PREFIX).toContain("output exactly: NONE");
  });

  it("documents the pinned=false contextual SET marker", () => {
    expect(REFLECTION_STABLE_PREFIX).toContain("pinned=false");
    expect(REFLECTION_STABLE_PREFIX).toContain("keywords=a,b,c");
    expect(REFLECTION_STABLE_PREFIX).toContain("Contextual");
  });

  it("freezes the reflection preamble as a snapshot (KV-cache hygiene)", () => {
    expect(REFLECTION_STABLE_PREFIX).toMatchInlineSnapshot(`
      "You are a memory extractor for a personal assistant.
      Given the last USER and ASSISTANT messages, output durable things worth remembering across sessions.

      Two output channels:
      - SET key=value    atomic key/value facts about the user (name, timezone, language, preferences, stated goals). Rendered into every future prompt, so keep them small and canonical.
      - NOTE body        freeform episodic observations worth recalling later (decisions taken, project conventions discovered, debugging findings, commitments). Stored but NOT auto-rendered; the agent looks them up on demand.

      SET has two flavours:
      - Default (pinned) — the fact is always rendered into \`### profile\`. Use for truly identity-level facts that apply to most turns (name, primary language, timezone).
      - Contextual — the fact is ONLY rendered when a keyword hits the current user message. Use for rare/large context (deploy commands, per-feature preferences, per-project env snippets). Emit as: SET key=value [pinned=false; keywords=a,b,c]. The [...] marker MUST be on the same line, keywords comma-separated, lowercase, 1–8 entries.

      Bi-temporal versioning:
      - Every SET preserves history automatically — re-writing the same key never erases the previous version. The earlier value is still available via the \`memory.profile.history\` tool.
      - When the user explicitly switches a value ("actually let's use X now"), add a supersession marker so future readers can see the intent: SET key=new_value [valid_from=now; supersedes=key]. Same-key supersession (e.g. language: ru → en) makes the chain explicit; cross-key supersession (e.g. SET full_name=Alex [supersedes=name]) marks both rows in a single write.
      - The valid_from token must be the literal "now"; the runtime stamps the actual timestamp.

      Rules:
      - Only durable content explicitly stated by the user or that the user asked to remember.
      - Skip trivia, chit-chat, weather, transient moods, facts about the AI itself.
      - Use SET for anything that looks like a stable attribute of the user. Prefer short snake_case keys (e.g. name, timezone, trip_lisbon_plan). Keep each SET value under 200 characters.
      - Prefer contextual SET when the fact is valuable only in a specific topic. If unsure, default to pinned SET.
      - Use NOTE for anything episodic or narrative that does not fit a single key. Keep each NOTE body under 500 characters. A NOTE may end with an optional tag marker " [tags=a,b,c]" (lowercase, snake or hyphen, up to 8 tags).
      - If a SET already captures the fact, do not also emit a NOTE repeating it.
      - If there is nothing worth remembering, output exactly: NONE
      - Otherwise output up to six lines total; each line is either "SET key=value" (optionally followed by a pinned/keywords marker) or "NOTE body".
      "
    `);
  });

  // --------------------------------------------------------------------------
  // Phase C: v2.5 typed-NOTE preamble
  // --------------------------------------------------------------------------

  it("phase C: picks REFLECTION_STABLE_PREFIX_TYPED when typedNotes=true", () => {
    const prompt = buildReflectionPrompt({
      userMessage: "hi",
      assistantReply: "hello",
      typedNotes: true,
    });
    expect(prompt.startsWith(REFLECTION_STABLE_PREFIX_TYPED)).toBe(true);
    expect(prompt.startsWith(REFLECTION_STABLE_PREFIX)).toBe(false);
  });

  it("phase C: falls back to legacy REFLECTION_STABLE_PREFIX when typedNotes is false/absent", () => {
    const a = buildReflectionPrompt({
      userMessage: "hi",
      assistantReply: "hello",
    });
    const b = buildReflectionPrompt({
      userMessage: "hi",
      assistantReply: "hello",
      typedNotes: false,
    });
    expect(a.startsWith(REFLECTION_STABLE_PREFIX)).toBe(true);
    expect(b.startsWith(REFLECTION_STABLE_PREFIX)).toBe(true);
    expect(a).toEqual(b);
  });

  it("phase C: typed prefix advertises all four canonical NOTE types", () => {
    for (const t of ["event", "behavior", "knowledge", "skill"]) {
      expect(REFLECTION_STABLE_PREFIX_TYPED).toContain(`[type=${t}]`);
    }
  });

  it("phase C: typed prefix lists per-type forbidden content", () => {
    expect(REFLECTION_STABLE_PREFIX_TYPED).toContain("Forbidden in every NOTE");
    expect(REFLECTION_STABLE_PREFIX_TYPED).toContain("NEVER use for a single one-off event");
    expect(REFLECTION_STABLE_PREFIX_TYPED).toContain("NEVER use for events or behaviors");
  });

  it("phase C: typed prefix is byte-stable across calls (KV-cache hygiene)", () => {
    const a = buildReflectionPrompt({
      userMessage: "x",
      assistantReply: "y",
      typedNotes: true,
    });
    const b = buildReflectionPrompt({
      userMessage: "different",
      assistantReply: "tail",
      typedNotes: true,
    });
    expect(a.slice(0, REFLECTION_STABLE_PREFIX_TYPED.length)).toEqual(
      b.slice(0, REFLECTION_STABLE_PREFIX_TYPED.length),
    );
  });

  // --------------------------------------------------------------------------
  // Phase B: v2.5 sliding-window segmentation
  // --------------------------------------------------------------------------

  it("phase B: renders numbered USER/ASSISTANT turns when transcript is provided", () => {
    const prompt = buildReflectionPrompt({
      userMessage: "ignored when transcript is present",
      assistantReply: "ignored too",
      transcript: [
        { user: "I'm in Lisbon", assistant: "Got it." },
        { user: "Plan a trip", assistant: "Sure, when?" },
        { user: "Next week", assistant: "Will do." },
      ],
    });
    expect(prompt).toContain("### turn 1\nUSER: I'm in Lisbon\nASSISTANT: Got it.");
    expect(prompt).toContain("### turn 2\nUSER: Plan a trip\nASSISTANT: Sure, when?");
    expect(prompt).toContain("### turn 3\nUSER: Next week\nASSISTANT: Will do.");
    expect(prompt).not.toContain("USER: ignored when transcript is present");
    expect(prompt.endsWith("### output\n")).toBe(true);
  });

  it("phase B: keeps the stable prefix byte-identical when transcript is present", () => {
    const singlePair = buildReflectionPrompt({
      userMessage: "x",
      assistantReply: "y",
    });
    const windowed = buildReflectionPrompt({
      userMessage: "x",
      assistantReply: "y",
      transcript: [{ user: "x", assistant: "y" }],
    });
    expect(singlePair.startsWith(REFLECTION_STABLE_PREFIX)).toBe(true);
    expect(windowed.startsWith(REFLECTION_STABLE_PREFIX)).toBe(true);
    expect(singlePair.slice(0, REFLECTION_STABLE_PREFIX.length)).toEqual(
      windowed.slice(0, REFLECTION_STABLE_PREFIX.length),
    );
  });

  it("phase B: empty transcript array falls back to legacy single-pair rendering", () => {
    const legacy = buildReflectionPrompt({
      userMessage: "hi",
      assistantReply: "hello",
    });
    const empty = buildReflectionPrompt({
      userMessage: "hi",
      assistantReply: "hello",
      transcript: [],
    });
    expect(legacy).toEqual(empty);
    expect(empty).toContain("USER: hi");
    expect(empty).not.toContain("### turn 1");
  });

  it("phase B: composes with typedNotes=true (typed prefix + multi-turn tail)", () => {
    const prompt = buildReflectionPrompt({
      userMessage: "x",
      assistantReply: "y",
      typedNotes: true,
      transcript: [
        { user: "alpha", assistant: "beta" },
        { user: "gamma", assistant: "delta" },
      ],
    });
    expect(prompt.startsWith(REFLECTION_STABLE_PREFIX_TYPED)).toBe(true);
    expect(prompt).toContain("### turn 1\nUSER: alpha\nASSISTANT: beta");
    expect(prompt).toContain("### turn 2\nUSER: gamma\nASSISTANT: delta");
  });

  it("phase B: clamps each turn in the transcript independently", () => {
    const huge = "x".repeat(REFLECTION_MESSAGE_CHAR_CAP + 200);
    const prompt = buildReflectionPrompt({
      userMessage: "ignored",
      assistantReply: "ignored",
      transcript: [
        { user: huge, assistant: "ok" },
        { user: "short", assistant: huge },
      ],
    });
    const userLines = prompt.match(/USER: (.+)/g) ?? [];
    for (const line of userLines) {
      const body = line.slice("USER: ".length);
      expect(body.length).toBeLessThanOrEqual(REFLECTION_MESSAGE_CHAR_CAP);
    }
    const assistantLines = prompt.match(/ASSISTANT: (.+)/g) ?? [];
    for (const line of assistantLines) {
      const body = line.slice("ASSISTANT: ".length);
      expect(body.length).toBeLessThanOrEqual(REFLECTION_MESSAGE_CHAR_CAP);
    }
  });

  it("clamps oversized messages to the character cap", () => {
    const huge = "x".repeat(REFLECTION_MESSAGE_CHAR_CAP + 500);
    const prompt = buildReflectionPrompt({
      userMessage: huge,
      assistantReply: "ok",
    });
    const userLine = prompt.match(/USER: (.+)/)?.[1] ?? "";
    expect(userLine.length).toBeLessThanOrEqual(REFLECTION_MESSAGE_CHAR_CAP);
    expect(userLine.endsWith("…")).toBe(true);
  });
});
