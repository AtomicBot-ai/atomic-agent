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
    expect(grammar).toContain(
      'think-prelude ::= think-body "</think>" prelude-trail-ws',
    );
    expect(grammar).toContain('think-fragment ::= [^<]+ | "<" [^/]');
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
  });

  it("does not introduce a prelude-trail-ws rule for plain-instruct profiles", async () => {
    const grammar = await buildGrammar(PLAIN_INSTRUCT_PROFILE);
    expect(grammar).not.toContain("prelude-trail-ws");
  });
});
