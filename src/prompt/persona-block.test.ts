import { describe, expect, it } from "vitest";

import { ANSWER_STYLE_HEADER } from "./answer-style.js";
import { buildPrompt } from "./build-prompt.js";
import type { BuildPromptInput } from "./build-prompt-types.js";
import { buildPersonaBlock, PERSONA_HEADER, type PersonaPromptInput } from "./persona-block.js";
import { buildStablePrefix, DEFAULT_SYSTEM_PERSONA, type CapabilitiesSummary } from "./stable-prefix.js";
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

const REVIEWER: PersonaPromptInput = {
  name: "reviewer",
  instructions: "Review code for bugs before style.",
  style: "Terse.",
};

function prefix(persona?: PersonaPromptInput): string {
  return buildStablePrefix({
    toolDescriptors: [],
    capabilities: CAPS,
    skillCatalog: [],
    answerStyle: { channel: "terminal", compact: true },
    ...(persona ? { persona } : {}),
  });
}

describe("### persona (ATO-54)", () => {
  it("is absent without a persona, so the prefix is unchanged", () => {
    expect(prefix()).not.toContain(PERSONA_HEADER);
    expect(prefix(undefined)).toBe(prefix());
  });

  it("adds the user's text after rules and answer-style, keeping the built-in persona", () => {
    const text = prefix(REVIEWER);
    expect(text).toContain(DEFAULT_SYSTEM_PERSONA);
    expect(text).toContain(`${PERSONA_HEADER}\n${buildPersonaBlock(REVIEWER)}\n\n### skills`);
    expect(text.indexOf("### rules")).toBeLessThan(text.indexOf(PERSONA_HEADER));
    expect(text.indexOf(ANSWER_STYLE_HEADER)).toBeLessThan(text.indexOf(PERSONA_HEADER));
    // Only the block is new: removing it gives back the persona-less prefix.
    expect(text.replace(`${PERSONA_HEADER}\n${buildPersonaBlock(REVIEWER)}\n\n`, "")).toBe(prefix());
  });

  it("names the persona, carries the text and the optional style line", () => {
    const block = buildPersonaBlock(REVIEWER);
    expect(block.split("\n")[0]).toContain("Active persona: reviewer.");
    expect(block).toContain(REVIEWER.instructions);
    expect(block.endsWith("Style: Terse.")).toBe(true);
    expect(buildPersonaBlock({ name: "w", instructions: "x" })).not.toContain("Style:");
  });

  it("is forwarded by buildPrompt", () => {
    const input: BuildPromptInput = {
      session: createEmptySessionState({ id: "persona", workingDir: "/repo" }),
      toolDescriptors: [],
      capabilities: CAPS,
      skillCatalog: [],
      tokenBudget: 8000,
    };
    expect(buildPrompt(input).stablePrefix).not.toContain(PERSONA_HEADER);
    expect(buildPrompt({ ...input, persona: REVIEWER }).stablePrefix).toContain(buildPersonaBlock(REVIEWER));
  });
});
