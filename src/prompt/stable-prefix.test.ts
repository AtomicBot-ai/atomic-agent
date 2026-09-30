import { describe, expect, it } from "vitest";

import {
  buildStablePrefix,
  DEFAULT_SYSTEM_PERSONA,
  NATIVE_TOOLS_SYSTEM_PERSONA,
  SYSTEM_PERSONA_INPUTS_LINE,
  type CapabilitiesSummary,
} from "./stable-prefix.js";
import { estimateTokens } from "./token-budget.js";

const CAPS: CapabilitiesSummary = {
  platform: "linux",
  arch: "x64",
  browserChannel: "none",
  workingDir: "/repo",
  hasClipboard: false,
  hasWmctrl: false,
  hasNotifications: false,
};

/**
 * F51. The persona line that tells the model what the input refusal
 * enforces (`fs-input-guard.ts`): a file that existed before the turn is
 * the user's — edit it in place, put new files beside it, never
 * regenerate it from memory; a rewrite the user asked for is said and
 * passed as `overwrite: true`.
 */
describe("the inputs line of the persona (F51)", () => {
  it("is the same sentence in both personas, right after the bias-toward-action line", () => {
    expect(SYSTEM_PERSONA_INPUTS_LINE).toBe(
      "Files that existed before this turn are the user's: edit them in place and write new files beside them; do not regenerate a provided file from memory. If the user asked for a rewrite, say so and pass overwrite: true.",
    );
    for (const persona of [DEFAULT_SYSTEM_PERSONA, NATIVE_TOOLS_SYSTEM_PERSONA]) {
      const lines = persona.split("\n");
      expect(lines[1]?.startsWith("Bias toward action:")).toBe(true);
      expect(lines[2]).toBe(SYSTEM_PERSONA_INPUTS_LINE);
      expect(lines[3]?.startsWith("Terminals:")).toBe(true);
      // Once, not repeated by any shared line.
      expect(persona.split(SYSTEM_PERSONA_INPUTS_LINE)).toHaveLength(2);
    }
  });

  it("reaches the built prefix on both transports, once, inside the persona", () => {
    for (const toolTransport of ["grammar", "native_tools"] as const) {
      const prefix = buildStablePrefix({
        toolDescriptors: [],
        capabilities: CAPS,
        skillCatalog: [],
        toolTransport,
      });
      expect(prefix.split(SYSTEM_PERSONA_INPUTS_LINE)).toHaveLength(2);
      expect(prefix.indexOf(SYSTEM_PERSONA_INPUTS_LINE)).toBeLessThan(
        prefix.indexOf("### rules"),
      );
    }
  });

  it("costs one short line, and the persona stays under its ceiling", () => {
    // Every persona byte is paid on every turn of every session. The
    // personas stand at ~1,310 estimated tokens; the ceiling is a guard
    // against runaway growth, the same kind as `### fusion`'s length pin.
    expect(estimateTokens(SYSTEM_PERSONA_INPUTS_LINE)).toBeLessThan(70);
    expect(estimateTokens(DEFAULT_SYSTEM_PERSONA)).toBeLessThan(1400);
    expect(estimateTokens(NATIVE_TOOLS_SYSTEM_PERSONA)).toBeLessThan(1400);
  });
});

/**
 * Issue #466. `### skills` used to end on an ordinary catalog row no
 * matter how many installed skills the budget had cut, so a clipped
 * catalog read as the complete one.
 */
describe("the ### skills truncation marker", () => {
  const CATALOG = [
    { name: "alpha", description: "a", source: "global" as const },
    { name: "beta", description: "b", source: "project" as const },
  ];

  function skillsBlock(prefix: string): string[] {
    const lines = prefix.split("\n");
    const start = lines.indexOf("### skills");
    expect(start).toBeGreaterThan(-1);
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => l.startsWith("### "));
    return rest.slice(0, end === -1 ? undefined : end).filter((l) => l !== "");
  }

  it("names the count and the knob after the last catalog row", () => {
    const prefix = buildStablePrefix({
      toolDescriptors: [],
      capabilities: CAPS,
      skillCatalog: CATALOG,
      skillCatalogDropped: 16,
    });
    const block = skillsBlock(prefix);
    expect(block).toHaveLength(3);
    expect(block[0]).toBe("- [global] alpha: a");
    expect(block[2]).toContain("16 more installed skills not shown");
    expect(block[2]).toContain("skills.catalogTokenBudget");
  });

  it("is absent — byte for byte — when nothing was dropped", () => {
    const base = buildStablePrefix({
      toolDescriptors: [],
      capabilities: CAPS,
      skillCatalog: CATALOG,
    });
    for (const skillCatalogDropped of [undefined, 0]) {
      expect(
        buildStablePrefix({
          toolDescriptors: [],
          capabilities: CAPS,
          skillCatalog: CATALOG,
          ...(skillCatalogDropped !== undefined ? { skillCatalogDropped } : {}),
        }),
      ).toBe(base);
    }
    expect(skillsBlock(base)).toHaveLength(2);
    expect(base).not.toContain("skills.catalogTokenBudget");
  });
});
