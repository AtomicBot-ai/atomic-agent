import { describe, expect, it } from "vitest";

import { parseStartContextFlags } from "./models-command.js";
import { formatStatusContextLine } from "./models-status-context.js";

describe("formatStatusContextLine", () => {
  it("states how far a growing window may still grow", () => {
    expect(formatStatusContextLine({ contextSize: 32_768, autoContextCeiling: 131_072 })).toBe(
      "context:        32768 tokens (auto: grows up to 131072 as the conversation does)\n",
    );
  });

  it("never claims growth for a launch that does not grow, or one at its ceiling", () => {
    expect(formatStatusContextLine({ contextSize: 131_072, autoContextCeiling: null })).toBe(
      "context:        131072 tokens\n",
    );
    expect(formatStatusContextLine({ contextSize: 131_072 })).toBe("context:        131072 tokens\n");
    expect(formatStatusContextLine({ contextSize: 131_072, autoContextCeiling: 131_072 })).toBe(
      "context:        131072 tokens\n",
    );
  });

  it("prints nothing without a daemon, or for a window left to llama.cpp", () => {
    expect(formatStatusContextLine(null)).toBeNull();
    expect(formatStatusContextLine({ contextSize: 0, autoContextCeiling: null })).toBeNull();
  });
});

describe("parseStartContextFlags (models start)", () => {
  it("reads --grow-context and --context-at-least", () => {
    expect(parseStartContextFlags(["start", "--interactive", "--grow-context", "--context-at-least", "65536"])).toEqual({
      growContext: true,
      contextAtLeast: 65_536,
    });
  });

  it("leaves a plain start as it was", () => {
    expect(parseStartContextFlags(["start", "--interactive"])).toEqual({});
  });

  it("ignores a size that is not a positive integer", () => {
    for (const bad of ["0", "-1", "64k", "1.5"]) {
      expect(parseStartContextFlags(["start", "--context-at-least", bad])).toEqual({});
    }
    expect(parseStartContextFlags(["start", "--context-at-least"])).toEqual({});
  });
});
