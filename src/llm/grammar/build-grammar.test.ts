import { describe, expect, it } from "vitest";

import {
  GEMMA4_THINK_PROFILE,
  PLAIN_INSTRUCT_PROFILE,
  QWEN_THINK_PROFILE,
} from "../model-profile.js";
import {
  buildGrammar,
  buildGrammarForTools,
  grammarToolNames,
} from "./build-grammar.js";

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

describe("fusion.delegate in the local-model grammar", () => {
  /**
   * The grammar is the local model's ENTIRE vocabulary of tool names: a
   * name that is not in it cannot be sampled, whatever the catalog says.
   *
   * This went unnoticed for as long as the orchestrator was always a
   * cloud provider, which carries a native `tools` payload and no
   * grammar. The moment the legs swap and a local model orchestrates,
   * the one tool the whole mode depends on was the one it could not
   * emit: the trace shows it reasoning "I need to call fusion.delegate"
   * and then emitting `finish`, reporting a fan-out that never ran.
   */
  it("admits the fan-out a local orchestrator has to call", async () => {
    for (const profile of [
      PLAIN_INSTRUCT_PROFILE,
      QWEN_THINK_PROFILE,
      GEMMA4_THINK_PROFILE,
    ]) {
      const grammar = await buildGrammar(profile);
      const toolName =
        grammar.split("\n").find((l) => l.startsWith("tool-name ::=")) ?? "";
      expect(toolName, profile.id).toContain("fusion-tool");
      expect(grammar, profile.id).toMatch(
        /^fusion-tool ::= "\\"fusion\.delegate\\""$/m,
      );
    }
  });

  it("keeps it out of the browser rule, so disabling the browser cannot take it away", async () => {
    const grammar = await buildGrammar(PLAIN_INSTRUCT_PROFILE, undefined, {
      browserEnabled: false,
    });
    const toolName =
      grammar.split("\n").find((l) => l.startsWith("tool-name ::=")) ?? "";
    expect(toolName).toContain("fusion-tool");
    expect(toolName).not.toContain("browser-tool");
  });
});

describe("os-tool names the local-model grammar admits", () => {
  it("includes the agent's e-mail tools — a descriptor the grammar cannot emit is a tool local models cannot call", () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const { resolve } = require("node:path") as typeof import("node:path");
    const grammar = readFileSync(
      resolve(__dirname, "../../../grammars/tool-call.gbnf"),
      "utf8",
    );
    const osToolLine =
      grammar.split("\n").find((l) => l.startsWith("os-tool ::=")) ?? "";
    for (const name of ["email.inbox", "email.send", "notify", "web.fetch"]) {
      expect(osToolLine).toContain(`"${name}"`);
    }
  });

  it("includes the git WRITE tools, not just the read half", () => {
    // Same class of bug as the missing `fusion.delegate`: the local-first
    // git tools were registered and described, and the grammar still only
    // named the read half — so a local model could inspect a repository
    // and never commit to one, with nothing in the logs saying why.
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const { resolve } = require("node:path") as typeof import("node:path");
    const grammar = readFileSync(
      resolve(__dirname, "../../../grammars/tool-call.gbnf"),
      "utf8",
    );
    const osToolLine =
      grammar.split("\n").find((l) => l.startsWith("os-tool ::=")) ?? "";
    for (const name of [
      "git.init",
      "git.add",
      "git.commit",
      "git.checkout",
      "git.clone",
      "git.remote",
      "git.fetch",
      "git.pull",
      "git.push",
    ]) {
      expect(osToolLine, name).toContain(`"${name}"`);
    }
  });
});

describe("buildGrammarForTools — the per-request grammar", () => {
  /**
   * The grammar travels with each request and is not part of the
   * KV-cached prefix, so a step can shrink the sampler's vocabulary
   * without touching the prompt. The rewrite must be surgical: one rule
   * replaced, every other byte identical, so the reasoning prelude and
   * the JSON body rules the profile invariants pin are untouched.
   */
  it("replaces only the tool-name rule and leaves every other line byte-identical", async () => {
    for (const profile of [
      PLAIN_INSTRUCT_PROFILE,
      QWEN_THINK_PROFILE,
      GEMMA4_THINK_PROFILE,
    ]) {
      const base = await buildGrammar(profile);
      const narrowed = buildGrammarForTools(base, ["os.fs.read", "reply"]);
      const baseLines = base.split("\n");
      const narrowedLines = narrowed.split("\n");
      expect(narrowedLines.length, profile.id).toBe(baseLines.length);
      for (let i = 0; i < baseLines.length; i += 1) {
        if (baseLines[i]!.startsWith("tool-name ::=")) {
          expect(narrowedLines[i], profile.id).toBe(
            'tool-name ::= "\\"os.fs.read\\"" | "\\"reply\\""',
          );
        } else {
          expect(narrowedLines[i], profile.id).toBe(baseLines[i]);
        }
      }
      expect(grammarToolNames(narrowed), profile.id).toEqual([
        "os.fs.read",
        "reply",
      ]);
    }
  });

  it("sorts and deduplicates, so the same set is the same bytes whatever the order", async () => {
    const base = await buildGrammar(PLAIN_INSTRUCT_PROFILE);
    const a = buildGrammarForTools(base, ["reply", "os.fs.write", "os.fs.read"]);
    const b = buildGrammarForTools(base, [
      "os.fs.read",
      "os.fs.read",
      "reply",
      "os.fs.write",
    ]);
    expect(a).toBe(b);
    expect(grammarToolNames(a)).toEqual(["os.fs.read", "os.fs.write", "reply"]);
  });

  it("is cached by the sorted name list — the second build is the same string", async () => {
    const base = await buildGrammar(PLAIN_INSTRUCT_PROFILE);
    const first = buildGrammarForTools(base, ["finish", "reply"]);
    const second = buildGrammarForTools(base, ["reply", "finish"]);
    // Reference equality: the cache handed back the same object.
    expect(second).toBe(first);
  });

  it("always keeps reply — a grammar with no exit would trap the step", async () => {
    const base = await buildGrammar(PLAIN_INSTRUCT_PROFILE);
    expect(grammarToolNames(buildGrammarForTools(base, []))).toEqual(["reply"]);
    expect(grammarToolNames(buildGrammarForTools(base, ["finish"]))).toEqual([
      "finish",
      "reply",
    ]);
  });

  it("keeps the profile/grammar invariants: the prelude root survives the rewrite", async () => {
    const { checkProfileGrammarAligned } = await import(
      "../profile-invariants.js"
    );
    for (const profile of [
      PLAIN_INSTRUCT_PROFILE,
      QWEN_THINK_PROFILE,
      GEMMA4_THINK_PROFILE,
    ]) {
      const base = await buildGrammar(profile);
      const narrowed = buildGrammarForTools(base, ["reply", "finish"]);
      expect(checkProfileGrammarAligned(profile, narrowed), profile.id).toEqual(
        [],
      );
    }
  });

  it("reports null for the static base grammar, whose rule is made of sub-rules", async () => {
    const base = await buildGrammar(PLAIN_INSTRUCT_PROFILE);
    expect(grammarToolNames(base)).toBeNull();
  });
});
