import { describe, expect, it } from "vitest";

import {
  GEMMA4_THINK_PROFILE,
  PLAIN_INSTRUCT_PROFILE,
  QWEN_THINK_PROFILE,
} from "./model-profile.js";
import {
  checkProfileGrammarAligned,
  checkProfilePromptAligned,
} from "./profile-invariants.js";

describe("checkProfileGrammarAligned", () => {
  it("flags a reasoning profile paired with plain grammar", () => {
    expect(checkProfileGrammarAligned(QWEN_THINK_PROFILE, "root ::= tool-call")).toHaveLength(2);
  });

  it("flags a gemma grammar that omits the configured close tag", () => {
    const grammar = "root ::= channel-prelude tool-call\nchannel-prelude ::= channel-body";
    expect(checkProfileGrammarAligned(GEMMA4_THINK_PROFILE, grammar)).toContain(
      "reasoning profile grammar must contain the configured close tag",
    );
  });

  it("accepts matching qwen reasoning grammar", () => {
    const grammar = [
      "root ::= think-prelude tool-call",
      'think-prelude ::= think-body "</think>" ws',
    ].join("\n");
    expect(checkProfileGrammarAligned(QWEN_THINK_PROFILE, grammar)).toEqual([]);
  });

  it("accepts matching gemma reasoning grammar", () => {
    const grammar = [
      "root ::= channel-prelude tool-call",
      'channel-prelude ::= channel-body "<channel|>" ws',
    ].join("\n");
    expect(checkProfileGrammarAligned(GEMMA4_THINK_PROFILE, grammar)).toEqual([]);
  });

  it("accepts the plain grammar for plain profile", () => {
    expect(checkProfileGrammarAligned(PLAIN_INSTRUCT_PROFILE, "root ::= tool-call")).toEqual(
      [],
    );
  });
});

describe("checkProfilePromptAligned", () => {
  it("flags a qwen prompt without a trailing think prelude", () => {
    const prompt = "### response\nEmit one JSON tool call now.\n";
    expect(checkProfilePromptAligned(QWEN_THINK_PROFILE, prompt)).toContain(
      "reasoning profile prompt must end with the configured open tag",
    );
  });

  it("flags a gemma prompt without a trailing channel prelude", () => {
    const prompt = "### response\nEmit one JSON tool call now.\n";
    expect(checkProfilePromptAligned(GEMMA4_THINK_PROFILE, prompt)).toContain(
      "reasoning profile prompt must end with the configured open tag",
    );
  });

  it("flags a plain prompt that leaks a reasoning prelude", () => {
    const prompt = "### response\nEmit one JSON tool call now.\n<think>\n";
    expect(checkProfilePromptAligned(PLAIN_INSTRUCT_PROFILE, prompt)).toContain(
      "plain profile prompt must not end with a reasoning prelude",
    );
  });

  it("accepts aligned prompts for all profiles", () => {
    expect(
      checkProfilePromptAligned(
        PLAIN_INSTRUCT_PROFILE,
        "### response\nEmit one JSON tool call now.\n",
      ),
    ).toEqual([]);
    expect(
      checkProfilePromptAligned(
        QWEN_THINK_PROFILE,
        "### response\nEmit one JSON tool call now.\n<think>\n",
      ),
    ).toEqual([]);
    expect(
      checkProfilePromptAligned(
        GEMMA4_THINK_PROFILE,
        "### response\nEmit one JSON tool call now.\n<|channel>thought\n",
      ),
    ).toEqual([]);
  });
});
