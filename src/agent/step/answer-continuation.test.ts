import { describe, expect, it } from "vitest";
import type { CompletionResult } from "../../llm/provider/completion-types.js";
import { PLAIN_INSTRUCT_PROFILE, QWEN_THINK_PROFILE } from "../../llm/model-profile.js";
import {
  CUT_AGAIN_NOTICE,
  cutAgainReplyBatch,
  decodePartialJsonString,
  extractPartialAnswer,
  formatContinuationNotice,
  isContinuableTruncation,
  joinContinuation,
  rewriteContinuedReply,
} from "./answer-continuation.js";

function completion(over: Partial<CompletionResult> = {}): CompletionResult {
  return {
    content: "",
    reasoningContent: "",
    stop: false,
    truncated: true,
    timing: { promptMs: 0, predictedMs: 0, promptTokens: 1, predictedTokens: 1 },
    cacheHitTokens: 0,
    slotId: -1,
    modelId: "fixture",
    ...over,
  };
}

const capCut = {
  reason: "truncated" as const,
  truncation: { cause: "reply_cap" as const, completionTokens: 16_384, promptTokens: 100 },
};

describe("isContinuableTruncation", () => {
  it("takes a cut against a reply cap or the provider's output limit", () => {
    expect(isContinuableTruncation(capCut, completion())).toBe(true);
    for (const cause of ["output_limit", "provider_limit"] as const) {
      expect(
        isContinuableTruncation(
          { reason: "truncated", truncation: { ...capCut.truncation, cause } },
          completion(),
        ),
      ).toBe(true);
    }
  });

  it("leaves a full window, an unknown wall, a loop, a runtime stop and non-truncations alone", () => {
    for (const cause of ["context_window", "unknown"] as const) {
      expect(
        isContinuableTruncation(
          { reason: "truncated", truncation: { ...capCut.truncation, cause } },
          completion(),
        ),
      ).toBe(false);
    }
    expect(
      isContinuableTruncation(
        { reason: "truncated", truncation: { ...capCut.truncation, repetitive: true } },
        completion(),
      ),
    ).toBe(false);
    expect(
      isContinuableTruncation(
        capCut,
        completion({ earlyStop: { reason: "repetition", channel: "content", periodChars: 40 } }),
      ),
    ).toBe(false);
    expect(isContinuableTruncation({ reason: "empty" }, completion())).toBe(false);
    expect(isContinuableTruncation({ reason: "truncated" }, completion())).toBe(false);
  });
});

describe("decodePartialJsonString", () => {
  it("decodes escapes and stops at the closing quote", () => {
    expect(decodePartialJsonString('line\\none \\"q\\" \\u00e9"}}]')).toBe('line\none "q" é');
  });

  it("drops an escape the cut split in half", () => {
    expect(decodePartialJsonString("abc\\")).toBe("abc");
    expect(decodePartialJsonString("abc\\u00")).toBe("abc");
  });
});

describe("extractPartialAnswer", () => {
  it("reads the text of a cut grammar reply", () => {
    const cut = completion({ content: '[{"tool":"reply","args":{"text":"Part one, and' });
    expect(extractPartialAnswer(cut, "grammar", PLAIN_INSTRUCT_PROFILE, false)).toBe("Part one, and");
  });

  it("reads it past a closed think block on a thinking profile", () => {
    const cut = completion({
      content: 'thought it through</think>[{"tool":"reply","args":{"text":"Answer starts'
    });
    expect(extractPartialAnswer(cut, "grammar", QWEN_THINK_PROFILE, true)).toBe("Answer starts");
  });

  it("has nothing to continue inside a think block, a tool call or an empty reply", () => {
    expect(
      extractPartialAnswer(completion({ content: "still thinking about" }), "grammar", QWEN_THINK_PROFILE, true),
    ).toBeNull();
    expect(
      extractPartialAnswer(
        completion({ content: '[{"tool":"os.fs.write","args":{"path":"a","content":"x' }),
        "grammar",
        PLAIN_INSTRUCT_PROFILE,
        false,
      ),
    ).toBeNull();
    expect(
      extractPartialAnswer(
        completion({ content: '[{"tool":"reply","args":{"text":"   ' }),
        "grammar",
        PLAIN_INSTRUCT_PROFILE,
        false,
      ),
    ).toBeNull();
  });

  it("reads a native reply call or plain prose, and nothing else", () => {
    const call = (name: string, args: string) =>
      completion({ toolCalls: [{ id: "c", type: "function", function: { name, arguments: args } }] });
    expect(
      extractPartialAnswer(call("reply", '{"text":"Half an ans'), "native_tools", PLAIN_INSTRUCT_PROFILE, false),
    ).toBe("Half an ans");
    expect(
      extractPartialAnswer(call("os__fs__write", '{"path":"a"'), "native_tools", PLAIN_INSTRUCT_PROFILE, false),
    ).toBeNull();
    expect(
      extractPartialAnswer(completion({ content: "Plain prose that was" }), "native_tools", PLAIN_INSTRUCT_PROFILE, false),
    ).toBe("Plain prose that was");
    expect(
      extractPartialAnswer(completion({ content: '[{"tool":"x"' }), "native_tools", PLAIN_INSTRUCT_PROFILE, false),
    ).toBeNull();
  });
});

describe("joinContinuation", () => {
  it("appends the rest as written", () => {
    expect(joinContinuation("Apples are re", "d and bananas are yellow.")).toBe(
      "Apples are red and bananas are yellow.",
    );
  });

  it("drops the words a model repeated from the end of the partial", () => {
    expect(
      joinContinuation("Step one: open the settings panel", "open the settings panel and pick Models."),
    ).toBe("Step one: open the settings panel and pick Models.");
  });

  it("believes a model that started over", () => {
    expect(joinContinuation("Intro, then", "Intro, then the full body.")).toBe("Intro, then the full body.");
  });
});

describe("rewriteContinuedReply", () => {
  it("joins the text into the first reply and keeps the calls after it", () => {
    const batch = {
      kind: "batch" as const,
      calls: [
        { tool: "reply", args: { text: " and the end." } },
        { tool: "os.fs.read", args: { path: "a" } },
      ],
    };
    const rewritten = rewriteContinuedReply(batch, "The start");
    expect(rewritten?.calls[0]).toEqual({ tool: "reply", args: { text: "The start and the end." } });
    expect(rewritten?.calls[1]).toEqual(batch.calls[1]);
  });

  it("refuses a batch that does not open with a reply", () => {
    expect(
      rewriteContinuedReply({ kind: "batch", calls: [{ tool: "finish", args: { summary: "x" } }] }, "p"),
    ).toBeNull();
  });
});

describe("cutAgainReplyBatch", () => {
  it("ends with what arrived and says it was cut", () => {
    const batch = cutAgainReplyBatch("First half", " and a bit");
    expect(batch.calls).toEqual([
      { tool: "reply", args: { text: `First half and a bit\n\n${CUT_AGAIN_NOTICE}` } },
    ]);
    expect(cutAgainReplyBatch("Only this", null).calls[0]!.args.text).toBe(
      `Only this\n\n${CUT_AGAIN_NOTICE}`,
    );
  });
});

describe("formatContinuationNotice", () => {
  it("quotes the partial and asks for the rest in the transport's shape", () => {
    const grammar = formatContinuationNotice("So far", "grammar");
    expect(grammar).toContain("### answer-continuation");
    expect(grammar).toContain("<<<PARTIAL\nSo far\nPARTIAL>>>");
    expect(grammar).toContain("length-1 JSON array");
    expect(formatContinuationNotice("So far", "native_tools")).toContain("function-calling interface");
  });
});
