import { describe, expect, it } from "vitest";

import {
  GEMMA4_THINK_PROFILE,
  NEMOTRON_THINK_PROFILE,
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

  // GBNF masks EOG until the whole root is satisfied, so any unbounded
  // rule is an infinite legal move for a stuck sampler. `ws` appears at
  // ~10 seams inside the JSON body; unbounded it produced a silent
  // newline-until-n_predict hang that surfaced nothing to the UI.
  it("bounds the shared whitespace rule so it cannot loop forever", async () => {
    for (const profile of [
      PLAIN_INSTRUCT_PROFILE,
      QWEN_THINK_PROFILE,
      NEMOTRON_THINK_PROFILE,
      GEMMA4_THINK_PROFILE,
    ]) {
      const grammar = await buildGrammar(profile);
      const ws = grammar.match(/^ws ::= .*$/m);
      expect(ws, profile.id).not.toBeNull();
      expect(ws![0], profile.id).toMatch(/\{0,\d+\}\s*$/);
      expect(ws![0], profile.id).not.toMatch(/\*\s*$/);
    }
  });

  it("builds a qwen think grammar with a think prelude routed into the array", async () => {
    const grammar = await buildGrammar(QWEN_THINK_PROFILE);
    expect(grammar).toContain("root ::= think-prelude tool-call-array");
    expect(grammar).toContain(
      'think-prelude ::= think-body "</think>" prelude-trail-ws',
    );
    expect(grammar).toContain('think-fragment ::= [^<]+ | "<" [^/]');
  });

  it("builds a nemotron think grammar with the same think prelude as qwen", async () => {
    // Nemotron prefills `<think>` in the prompt (like qwen), so the
    // prelude must NOT force the open sentinel — only the close tag.
    const grammar = await buildGrammar(NEMOTRON_THINK_PROFILE);
    expect(grammar).toContain("root ::= think-prelude tool-call-array");
    expect(grammar).toContain(
      'think-prelude ::= think-body "</think>" prelude-trail-ws',
    );
    expect(grammar).toContain("prelude-trail-ws ::= ( [ \\t\\n\\r] ){0,8}");
    expect(grammar).not.toContain('think-prelude ::= "<think>"');
  });

  it("builds a gemma 4 grammar with a channel prelude that forces the model-emitted open tag", async () => {
    const grammar = await buildGrammar(GEMMA4_THINK_PROFILE);
    expect(grammar).toContain("root ::= channel-prelude tool-call-array");
    // The model emits its own `<|channel>thought\n` opener (no prompt
    // prefill), so the prelude leads with the open sentinel literal.
    expect(grammar).toContain(
      'channel-prelude ::= "<|channel>thought\\n" channel-body "<channel|>" prelude-trail-ws',
    );
    expect(grammar).toContain('channel-fragment ::= [^<]+ | "<" [^c]');
  });

  it("bounds the whitespace between the reasoning-close sentinel and the tool-call array", async () => {
    // Pinned anti-degenerate-loop guard: small reasoning-capable models
    // (Gemma 4 26B-A4B in particular) used to slide into an unbounded
    // whitespace tail after `<channel|>` because the global `ws` rule is
    // `[ \t\n\r]*`. We now route the trailing seam through a bounded
    // `prelude-trail-ws ::= ( [ \t\n\r] ){0,8}` rule so the sampler must
    // converge on `[` within at most eight whitespace tokens.
    const gemma = await buildGrammar(GEMMA4_THINK_PROFILE);
    expect(gemma).toContain("prelude-trail-ws ::= ( [ \\t\\n\\r] ){0,8}");
    expect(gemma).not.toMatch(
      /^channel-prelude ::= channel-body "<channel\|>" ws$/m,
    );

    const qwen = await buildGrammar(QWEN_THINK_PROFILE);
    expect(qwen).toContain("prelude-trail-ws ::= ( [ \\t\\n\\r] ){0,8}");
    expect(qwen).not.toMatch(/^think-prelude ::= think-body "<\/think>" ws$/m);

    const nemotron = await buildGrammar(NEMOTRON_THINK_PROFILE);
    expect(nemotron).toContain("prelude-trail-ws ::= ( [ \\t\\n\\r] ){0,8}");
    expect(nemotron).not.toMatch(
      /^think-prelude ::= think-body "<\/think>" ws$/m,
    );
  });

  it("does not introduce a prelude-trail-ws rule for plain-instruct profiles", async () => {
    const grammar = await buildGrammar(PLAIN_INSTRUCT_PROFILE);
    expect(grammar).not.toContain("prelude-trail-ws");
  });

  it("keeps browser-tool in the tool-name rule by default", async () => {
    const grammar = await buildGrammar(PLAIN_INSTRUCT_PROFILE);
    expect(grammar).toMatch(/^tool-name ::= .*\bbrowser-tool\b/m);
  });

  it("strips browser-tool from the tool-name rule when browserEnabled is false", async () => {
    const grammar = await buildGrammar(PLAIN_INSTRUCT_PROFILE, undefined, {
      browserEnabled: false,
    });
    const toolNameLine = grammar
      .split("\n")
      .find((line) => line.startsWith("tool-name ::="));
    expect(toolNameLine).toBeDefined();
    expect(toolNameLine).not.toContain("browser-tool");
    // Sibling alternatives survive and the alternation stays well-formed.
    expect(toolNameLine).toContain("os-tool");
    expect(toolNameLine).not.toMatch(/\|\s*\|/);
    expect(toolNameLine).not.toMatch(/::=\s*\|/);
  });
});
