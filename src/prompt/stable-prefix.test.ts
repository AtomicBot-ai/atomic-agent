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
