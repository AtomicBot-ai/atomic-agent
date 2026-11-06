import { describe, expect, it } from "vitest";
import {
  applyCompactToolForms,
  COMPACT_PROMPT_MAX_WINDOW,
  CompactPromptLatch,
  compactSkillCatalogBudget,
  decideCompactPrompt,
} from "./compact-prompt.js";
import { COMPACT_TOOL_FORMS } from "./compact-tool-forms.js";
import { DEFAULT_TOOL_DESCRIPTORS } from "./tool-descriptors.js";
import {
  buildStablePrefix,
  COMPACT_SYSTEM_PERSONA,
  DEFAULT_SYSTEM_PERSONA,
  SYSTEM_PERSONA_INPUTS_LINE,
  type CapabilitiesSummary,
  type ToolDescriptor,
} from "./stable-prefix.js";
import { estimateTokens } from "./token-budget.js";
import { buildPrompt } from "./build-prompt.js";
import { createEmptySessionState } from "../session/session-state.js";
import { PLAIN_INSTRUCT_PROFILE } from "../llm/model-profile.js";

const CAPS: CapabilitiesSummary = {
  platform: "darwin",
  arch: "arm64",
  browserChannel: "chrome",
  workingDir: "/work",
  hasClipboard: true,
  hasWmctrl: false,
  hasNotifications: true,
};

function prefix(compact: boolean, toolTransport?: "grammar" | "native_tools"): string {
  return buildStablePrefix({
    toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
    capabilities: CAPS,
    skillCatalog: [],
    ...(toolTransport ? { toolTransport } : {}),
    ...(compact ? { compact: true } : {}),
  });
}

describe("compact scaffold size", () => {
  // Measured when this landed: 9651 -> 3727 estimated tokens (grammar),
  // 9655 -> 3700 (native tools), every default descriptor mounted.
  it.each(["grammar", "native_tools"] as const)(
    "is at least 40%% smaller than the full scaffold on the default tool set (%s)",
    (transport) => {
      const full = estimateTokens(prefix(false, transport));
      const compact = estimateTokens(prefix(true, transport));
      expect(compact).toBeLessThanOrEqual(full * 0.6);
    },
  );

  it("leaves the full scaffold byte-identical when compact is off or omitted", () => {
    const omitted = prefix(false);
    expect(
      buildStablePrefix({
        toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
        capabilities: CAPS,
        skillCatalog: [],
        compact: false,
      }),
    ).toBe(omitted);
    expect(omitted).toContain(DEFAULT_SYSTEM_PERSONA);
    expect(omitted).not.toContain(COMPACT_SYSTEM_PERSONA);
  });

  it("is byte-stable across builds with the same input (prefix cache)", () => {
    expect(prefix(true)).toBe(prefix(true));
  });
});

describe("compact scaffold content", () => {
  const compact = prefix(true);

  it("keeps the rules that stop real small-model failures", () => {
    expect(compact).toContain(COMPACT_SYSTEM_PERSONA);
    expect(compact).toContain(SYSTEM_PERSONA_INPUTS_LINE);
    expect(compact).toContain("oldString must match the file text exactly");
    expect(compact).toContain("`cmd` is required and must not be empty");
    expect(compact).toContain("`prompt` is required");
  });

  it("renders every frequent tool's argsSchema verbatim (no drift from the grammar)", () => {
    for (const d of applyCompactToolForms(DEFAULT_TOOL_DESCRIPTORS)) {
      if (d.tier === "rare") continue;
      expect(compact).toContain(`- ${d.name} — ${d.summary}\n  args: ${d.argsSchema}`);
    }
  });

  it("lists compact-rare tools as one-liners under # extras", () => {
    expect(compact).toContain("- verify.run — ");
    expect(compact).not.toContain("kind 'command': a test runner");
    expect(compact).toMatch(/# extras \(one-line; use `tool\.view`/);
  });

  it("lists a name the catalog carries twice only once", () => {
    expect(compact.match(/^- os\.git\.push — /gm)).toHaveLength(1);
    expect(compact.match(/^- os\.git\.commit — /gm)).toHaveLength(1);
  });
});

describe("authored compact forms", () => {
  const names = new Set(DEFAULT_TOOL_DESCRIPTORS.map((d) => d.name));

  it("cover every default descriptor", () => {
    const missing = [...names].filter((n) => !COMPACT_TOOL_FORMS.has(n));
    expect(missing).toEqual([]);
  });

  it("name only real default descriptors", () => {
    const stray = [...COMPACT_TOOL_FORMS.keys()].filter((n) => !names.has(n));
    expect(stray).toEqual([]);
  });

  it("are whole sentences, much shorter in total than the long summaries", () => {
    // A form may be longer than a terse original on purpose: os.fs.edit
    // spells out the exact-match rule that small models missed.
    let full = 0;
    let short = 0;
    for (const d of DEFAULT_TOOL_DESCRIPTORS) {
      const form = COMPACT_TOOL_FORMS.get(d.name)!;
      expect(form.summary).toMatch(/\.$/);
      full += d.summary.length;
      short += form.summary.length;
    }
    expect(short).toBeLessThan(full * 0.5);
  });
});

describe("applyCompactToolForms", () => {
  const base: ToolDescriptor = {
    name: "x.tool",
    summary: "Long summary. With a second sentence.",
    argsSchema: "{ a: string }",
    examples: ['{"a":"1"}'],
    compact: { summary: "Short.", tier: "rare" },
  };

  it("swaps summary and tier, drops examples, keeps args and does not mutate", () => {
    const [out] = applyCompactToolForms([base]);
    expect(out).toMatchObject({ name: "x.tool", summary: "Short.", tier: "rare", argsSchema: "{ a: string }" });
    expect(out!.examples).toBeUndefined();
    expect(base.summary).toBe("Long summary. With a second sentence.");
    expect(base.examples).toEqual(['{"a":"1"}']);
  });

  it("passes a descriptor with no compact form (MCP, plugin) through as is", () => {
    const mcp: ToolDescriptor = { name: "mcp.s.t", summary: "s", argsSchema: "{}", tier: "rare" };
    expect(applyCompactToolForms([mcp])[0]).toBe(mcp);
  });
});

describe("decideCompactPrompt", () => {
  it("auto: on at or below 64K, off above and when the window is unknown", () => {
    expect(COMPACT_PROMPT_MAX_WINDOW).toBe(65_536);
    expect(decideCompactPrompt("auto", 16_384).compact).toBe(true);
    expect(decideCompactPrompt("auto", 65_536).compact).toBe(true);
    expect(decideCompactPrompt("auto", 65_537).compact).toBe(false);
    expect(decideCompactPrompt("auto", 262_144).compact).toBe(false);
    expect(decideCompactPrompt("auto", null)).toEqual({
      compact: false,
      reason: "auto: window unknown",
      contextWindow: null,
    });
    expect(decideCompactPrompt("auto", 0).compact).toBe(false);
    expect(decideCompactPrompt("auto", 32_768).reason).toBe("auto: window 32768");
    expect(decideCompactPrompt("auto", 32_768).contextWindow).toBe(32_768);
  });

  it("on / off ignore the window", () => {
    expect(decideCompactPrompt("on", 1_000_000).compact).toBe(true);
    expect(decideCompactPrompt("on", null).compact).toBe(true);
    expect(decideCompactPrompt("off", 8_192).compact).toBe(false);
  });
});

describe("CompactPromptLatch", () => {
  it("keeps a session's known-window decision when a later step cannot see the window", () => {
    const latch = new CompactPromptLatch();
    expect(latch.resolve("a", "auto", 32_768).compact).toBe(true);
    expect(latch.resolve("a", "auto", null)).toEqual({
      compact: true,
      reason: "auto: window 32768",
      contextWindow: 32_768,
    });
    expect(latch.resolve("a", "auto", undefined).compact).toBe(true);
    // Another session has nothing latched.
    expect(latch.resolve("b", "auto", null).compact).toBe(false);
  });

  it("holds nothing across instances (per loop, no module state)", () => {
    new CompactPromptLatch().resolve("a", "auto", 32_768);
    expect(new CompactPromptLatch().resolve("a", "auto", null).compact).toBe(false);
  });

  it("re-decides on a different known window (another model, cold cache anyway)", () => {
    const latch = new CompactPromptLatch();
    expect(latch.resolve("a", "auto", 32_768).compact).toBe(true);
    expect(latch.resolve("a", "auto", 131_072).compact).toBe(false);
    expect(latch.resolve("a", "auto", null).compact).toBe(false);
  });

  it("takes on / off as written; `on` keeps the last known window for the catalog", () => {
    const latch = new CompactPromptLatch();
    expect(latch.resolve("a", "auto", 32_768).compact).toBe(true);
    expect(latch.resolve("a", "off", null).compact).toBe(false);
    expect(latch.resolve("a", "on", 200_000).compact).toBe(true);
    expect(latch.resolve("a", "on", null)).toEqual({
      compact: true,
      reason: "on",
      contextWindow: 200_000,
    });
  });
});

describe("compactSkillCatalogBudget", () => {
  it("is min(configured, window share), never below 1", () => {
    expect(compactSkillCatalogBudget(512, 32_768)).toBe(163);
    expect(compactSkillCatalogBudget(512, 16_384)).toBe(81);
    expect(compactSkillCatalogBudget(100, 32_768)).toBe(100);
    expect(compactSkillCatalogBudget(512, 200_000)).toBe(512);
    expect(compactSkillCatalogBudget(512, 100)).toBe(1);
    expect(compactSkillCatalogBudget(512, null)).toBe(512);
  });
});

describe("buildPrompt compact wiring", () => {
  const session = {
    ...createEmptySessionState({ id: "compact-s", workingDir: "/work" }),
    turns: [{ kind: "user" as const, text: "hi", at: 1 }],
  };
  const skills = Array.from({ length: 60 }, (_, i) => ({
    name: `skill-${i}`,
    description: `Does thing number ${i} with a reasonably long description line`,
    source: "global" as const,
  }));
  const build = (
    contextWindow: number | undefined,
    compactPrompt?: boolean,
    compactPromptWindow?: number | null,
  ) =>
    buildPrompt({
      session,
      toolDescriptors: DEFAULT_TOOL_DESCRIPTORS,
      capabilities: CAPS,
      skillCatalog: skills,
      profile: {
        ...PLAIN_INSTRUCT_PROFILE,
        ...(contextWindow !== undefined ? { contextWindow } : {}),
      },
      ...(compactPrompt !== undefined ? { compactPrompt } : {}),
      ...(compactPromptWindow !== undefined ? { compactPromptWindow } : {}),
    });

  it("auto picks the compact scaffold on a 32K window and the full one on 128K or unknown", () => {
    expect(build(32_768).stablePrefix).toContain(COMPACT_SYSTEM_PERSONA);
    expect(build(131_072).stablePrefix).toContain(DEFAULT_SYSTEM_PERSONA);
    expect(build(undefined).stablePrefix).toContain(DEFAULT_SYSTEM_PERSONA);
  });

  it("an explicit compactPrompt from the step wins over the window", () => {
    expect(build(32_768, false).stablePrefix).toContain(DEFAULT_SYSTEM_PERSONA);
    expect(build(131_072, true).stablePrefix).toContain(COMPACT_SYSTEM_PERSONA);
  });

  it("scales the skill catalog down to the window and says how many were hidden", () => {
    const small = build(16_384).stablePrefix;
    const large = build(131_072).stablePrefix;
    const shown = (p: string) => (p.match(/^- \[global\] skill-/gm) ?? []).length;
    expect(shown(small)).toBeLessThan(shown(large));
    expect(small).toMatch(/more installed skills not shown \(skills\.catalogTokenBudget\)/);
  });
  it("a latched 32K decision keeps the stable prefix byte-identical on a step with no window", () => {
    // The latch holds the window with the decision, so the window-scaled
    // skill catalog does not grow back to the configured budget when a
    // later step cannot see the window.
    const latch = new CompactPromptLatch();
    const first = latch.resolve(session.id, "auto", 32_768);
    const second = latch.resolve(session.id, "auto", null);
    const a = build(32_768, first.compact, first.contextWindow).stablePrefix;
    const b = build(undefined, second.compact, second.contextWindow).stablePrefix;
    expect(b).toBe(a);
    expect(b).toContain(COMPACT_SYSTEM_PERSONA);
    // Without the latched window the catalog would change mid-session.
    expect(build(undefined, true).stablePrefix).not.toBe(a);
  });
});
