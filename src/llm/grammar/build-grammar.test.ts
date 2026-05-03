import { describe, expect, it } from "vitest";

import {
  GEMMA4_THINK_PROFILE,
  PLAIN_INSTRUCT_PROFILE,
  QWEN_THINK_PROFILE,
} from "../model-profile.js";
import { buildGrammar } from "./build-grammar.js";

describe("buildGrammar", () => {
  it("keeps the plain instruct grammar pinned to the array-only root", async () => {
    const grammar = await buildGrammar(PLAIN_INSTRUCT_PROFILE);
    expect(grammar).toContain("root ::= tool-call-array");
    expect(grammar).toContain("tool-call-array");
    expect(grammar).not.toContain("think-prelude ::= think-body");
  });

  it("builds a qwen think grammar with a think prelude routed into the array", async () => {
    const grammar = await buildGrammar(QWEN_THINK_PROFILE);
    expect(grammar).toContain("root ::= think-prelude tool-call-array");
    expect(grammar).toContain('think-prelude ::= think-body "</think>" ws');
    expect(grammar).toContain('think-fragment ::= [^<]+ | "<" [^/]');
  });

  it("builds a gemma 4 grammar with a channel prelude routed into the array", async () => {
    const grammar = await buildGrammar(GEMMA4_THINK_PROFILE);
    expect(grammar).toContain("root ::= channel-prelude tool-call-array");
    expect(grammar).toContain('channel-prelude ::= channel-body "<channel|>" ws');
    expect(grammar).toContain('channel-fragment ::= [^<]+ | "<" [^c]');
  });
});
