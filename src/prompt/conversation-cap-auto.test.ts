import { describe, expect, it } from "vitest";

import { buildPrompt } from "./build-prompt.js";
import { createEmptySessionState } from "../session/session-state.js";
import type { SessionState } from "../session/session-state.js";
import { USER_CONFIG_DEFAULTS } from "../config/index.js";
import { PLAIN_INSTRUCT_PROFILE } from "../llm/model-profile.js";
import type {
  CapabilitiesSummary,
  SkillCatalogEntry,
  ToolDescriptor,
} from "./stable-prefix.js";
import type { ConversationTurn } from "../session/conversation-turn.js";

const TOOLS: ToolDescriptor[] = [
  { name: "finish", summary: "Signal goal completion.", argsSchema: "{}" },
];
const CAPS: CapabilitiesSummary = {
  browser: false,
  filesystem: false,
  shell: false,
  network: false,
};
const SKILLS: SkillCatalogEntry[] = [];

function sessionWith(turns: ConversationTurn[]): SessionState {
  return { ...createEmptySessionState({ id: "s", workingDir: "/work" }), turns };
}

function task(i: number): ConversationTurn[] {
  return [
    { kind: "user", text: `ask ${i}`, at: 1000 + i * 10 },
    { kind: "assistant_reply", text: `answer ${i}`, at: 1001 + i * 10 },
  ];
}

function build(overrides: Record<string, unknown>) {
  return buildPrompt({
    session: sessionWith([...task(1), ...task(2), ...task(3)]),
    toolDescriptors: TOOLS,
    capabilities: CAPS,
    skillCatalog: SKILLS,
    ...overrides,
  });
}

/**
 * `set auto` promises the transcript will fill whatever the model's
 * window leaves. It used to do the opposite whenever nothing knew the
 * window: auto dropped the explicit cap, `defaultBudget` fell back to
 * its `tokenBudget * 0.35` share — 1050 with the shipped default — and
 * with no window to measure against, that fallback *was* the answer.
 * Pressing the button on a cloud model took the transcript from 32k to
 * 1050.
 *
 * The existing coverage in `token-budget.test.ts` could not catch it,
 * because it hands `computeEffectiveConversationCap` a `configuredCap`
 * directly instead of going through `buildPrompt`, which is where the
 * substitution happens.
 */
describe("the transcript cap under auto", () => {
  it("never collapses to the budget share when no window is known", () => {
    const built = build({ conversationMaxTokens: 0 });
    expect(built.contextWindow).toBeNull();
    expect(built.conversationCapAuto).toBe(true);
    expect(built.conversationCapEffective).toBe(
      USER_CONFIG_DEFAULTS.agent.conversationMaxTokens,
    );
    expect(built.conversationCapEffective).toBeGreaterThan(10_000);
  });

  it("is never worse than the fixed cap it replaced", () => {
    // The whole promise of the button in one line.
    const fixed = build({ conversationMaxTokens: 32_000 });
    const auto = build({ conversationMaxTokens: 0 });
    expect(auto.conversationCapEffective).toBeGreaterThanOrEqual(
      fixed.conversationCapEffective,
    );
  });

  it("fills the window when one is known", () => {
    const auto = build({ conversationMaxTokens: 0, contextWindow: 128_000 });
    expect(auto.contextWindow).toBe(128_000);
    expect(auto.conversationCapEffective).toBeGreaterThan(32_000);
  });
});

/**
 * The catalogue knows a cloud model's window; the `/props` probe does
 * not exist there. Until this input existed the budget simply had no
 * window off the local path.
 */
describe("where the window comes from", () => {
  it("takes the caller's window when there is no profile probe", () => {
    expect(build({ contextWindow: 200_000 }).contextWindow).toBe(200_000);
  });

  it("prefers the probe when both are known", () => {
    // The probe is the physical truth about the server actually serving
    // this request; the catalogue is a published figure about a name.
    const built = build({
      profile: { ...PLAIN_INSTRUCT_PROFILE, contextWindow: 8_192 },
      contextWindow: 128_000,
    });
    expect(built.contextWindow).toBe(8_192);
  });

  it("still reports no window when neither knows one", () => {
    expect(build({}).contextWindow).toBeNull();
  });
});

describe("what the prompt reports about pairs", () => {
  it("counts the tasks it carried and the cap in force", () => {
    const built = build({ conversationMaxPairs: 2 });
    expect(built.conversationPairsCap).toBe(2);
    expect(built.conversationPairs).toBe(2);
    expect(built.droppedPairs).toBe(1);
  });

  it("publishes a cost per task, oldest first", () => {
    const built = build({ conversationMaxPairs: 100 });
    expect(built.pairCosts).toHaveLength(3);
    for (const cost of built.pairCosts) expect(cost).toBeGreaterThan(0);
  });
});

/**
 * The default is a real behaviour change: before this, only the 32k
 * token cap bound, and a long, cheap history survived whole. Pinned so
 * it can never drift silently.
 */
describe("the shipped default", () => {
  it("carries twenty tasks and no more", () => {
    const many: ConversationTurn[] = [];
    for (let i = 0; i < 30; i += 1) many.push(...task(i));
    const built = buildPrompt({
      session: sessionWith(many),
      toolDescriptors: TOOLS,
      capabilities: CAPS,
      skillCatalog: SKILLS,
    });
    expect(built.conversationPairsCap).toBe(
      USER_CONFIG_DEFAULTS.agent.conversationMaxPairs,
    );
    expect(built.conversationPairs).toBe(20);
    expect(built.droppedPairs).toBe(10);
    expect(built.text).not.toContain("ask 0");
    expect(built.text).toContain("ask 29");
  });
});
