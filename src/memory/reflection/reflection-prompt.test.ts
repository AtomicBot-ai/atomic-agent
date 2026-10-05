import { describe, expect, it } from "vitest";

import {
  REFLECTION_KNOWN_PROFILE_MAX_FACTS,
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
      - When the user explicitly switches a value ("actually let's use X now"), add a supersession marker so future readers can see the intent: SET key=new_value [valid_from=now; supersedes=key]. Same-key supersession (e.g. language: ru → en) makes the chain explicit; cross-key supersession (e.g. SET new_key=value [supersedes=old_key]) marks both rows in a single write.
      - The valid_from token must be the literal "now"; the runtime stamps the actual timestamp.

      Rules:
      - Only durable content explicitly stated by the user or that the user asked to remember.
      - Never invent identity details (name, nickname, role, age, location); record a name only if the USER typed it.
      - A one-off instruction for the current reply ("reply exactly X", "don't use tools for this", test or ping messages) is not a preference.
      - Never copy wording or example values from these instructions into the output.
      - Write NOTE bodies about the user in the third person ("The user prefers ..."), never as "I ..." or "you ...".
      - When unsure, output NONE.
      - Skip trivia, chit-chat, weather, transient moods, facts about the AI itself.
      - Use SET for anything that looks like a stable attribute of the user. Prefer short snake_case keys (e.g. name, timezone, trip_lisbon_plan). Keep each SET value under 200 characters.
      - Prefer contextual SET when the fact is valuable only in a specific topic. If unsure, default to pinned SET.
      - Use NOTE for anything episodic or narrative that does not fit a single key. Keep each NOTE body under 500 characters. A NOTE may end with an optional tag marker " [tags=a,b,c]" (lowercase, snake or hyphen, up to 8 tags).
      - If a SET already captures the fact, do not also emit a NOTE repeating it.
      - A "### known profile" block, when present, lists facts already stored. Never emit a SET that repeats one of them, under its key or any other; to change one, reuse its exact key.
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
    expect(REFLECTION_STABLE_PREFIX_TYPED).toContain(
      "NEVER use for a single one-off event",
    );
    expect(REFLECTION_STABLE_PREFIX_TYPED).toContain(
      "NEVER use for events or behaviors",
    );
  });

  // B09: a small local model copied the prompt's own example name
  // ("Alex") into a note and turned "Reply exactly LOCAL_OK. Do not use
  // tools." into a lasting preference. The user-centric prefixes must
  // carry no concrete person name and must spell out the grounding rules.
  it("user-centric prefixes carry no example person name and state the grounding rules", () => {
    for (const prefix of [REFLECTION_STABLE_PREFIX, REFLECTION_STABLE_PREFIX_TYPED]) {
      expect(prefix).not.toMatch(/\bAlex\b/);
      expect(prefix).toContain("Never invent identity details");
      expect(prefix).toContain("A one-off instruction for the current reply");
      expect(prefix).toContain("Never copy wording or example values");
      expect(prefix).toContain("When unsure, output NONE.");
      // The identity rule must not narrow general extraction: facts the
      // user asked to remember (an assistant-found deploy command) and
      // plain statements ("I prefer TypeScript") stay extractable.
      expect(prefix).toContain("or that the user asked to remember");
      expect(prefix).not.toContain("Use only what the USER wrote");
      expect(prefix).not.toContain("Record a preference only when");
    }
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
    expect(prompt).toContain(
      "### turn 1\nUSER: I'm in Lisbon\nASSISTANT: Got it.",
    );
    expect(prompt).toContain(
      "### turn 2\nUSER: Plan a trip\nASSISTANT: Sure, when?",
    );
    expect(prompt).toContain(
      "### turn 3\nUSER: Next week\nASSISTANT: Will do.",
    );
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

  // ATO-188: reflection wrote facts the profile already held, under new
  // keys. It now sees the profile, after the stable prefix.
  it("renders the known profile into the tail, never into the stable prefix", () => {
    const prompt = buildReflectionPrompt({
      userMessage: "keep it short",
      assistantReply: "ok",
      knownProfile: [
        { key: "prefers_short_answers", value: "yes" },
        { key: "timezone", value: "Europe/Lisbon" },
      ],
    });
    expect(prompt.startsWith(REFLECTION_STABLE_PREFIX)).toBe(true);
    const tail = prompt.slice(REFLECTION_STABLE_PREFIX.length);
    expect(tail).toBe(
      "\n### known profile\n- prefers_short_answers=yes\n- timezone=Europe/Lisbon\n" +
        "\nUSER: keep it short\nASSISTANT: ok\n\n### output\n",
    );
    for (const prefix of [REFLECTION_STABLE_PREFIX, REFLECTION_STABLE_PREFIX_TYPED]) {
      expect(prefix).toContain('A "### known profile" block');
      expect(prefix).toContain("reuse its exact key");
    }
  });

  it("leaves the tail byte-identical without a known profile, and caps a big one", () => {
    const plain = buildReflectionPrompt({ userMessage: "x", assistantReply: "y" });
    const empty = buildReflectionPrompt({ userMessage: "x", assistantReply: "y", knownProfile: [] });
    expect(empty).toBe(plain);
    expect(plain).not.toContain("### known profile");

    const many = Array.from({ length: REFLECTION_KNOWN_PROFILE_MAX_FACTS + 5 }, (_, i) => ({
      key: `k${i}`,
      value: "v".repeat(200),
    }));
    const big = buildReflectionPrompt({ userMessage: "x", assistantReply: "y", knownProfile: many });
    const lines = big.split("\n").filter((l) => l.startsWith("- k"));
    expect(lines).toHaveLength(REFLECTION_KNOWN_PROFILE_MAX_FACTS);
    expect(lines[0]!.endsWith("…")).toBe(true);
    expect(lines[0]!.length).toBeLessThan(100);
  });
});
