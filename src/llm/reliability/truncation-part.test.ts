import { describe, expect, it } from "vitest";
import { locateCut } from "./truncation-part.js";

const cut = (content: string, reasoningContent = "", toolCalls?: Array<{ name: string; arguments: string }>) => ({
  content,
  reasoningContent,
  ...(toolCalls !== undefined
    ? { toolCalls: toolCalls.map((fn) => ({ type: "function" as const, function: fn })) }
    : {}),
});

describe("locateCut (ATO-1678)", () => {
  it("a native tool call cut in its arguments names the call", () => {
    expect(
      locateCut(cut("", "planning", [{ name: "os.fs.write", arguments: '{"path":"a.html","content":"<html>' }])),
    ).toEqual({ part: "tool_call", tool: "os.fs.write" });
  });

  it("a grammar call cut in its arguments names the last call opened", () => {
    expect(
      locateCut(cut('[{"tool":"os.fs.read","args":{"path":"a"}},{"tool":"os.fs.write","args":{"content":"abc')),
    ).toEqual({ part: "tool_call", tool: "os.fs.write" });
  });

  it("a cut inside the think block is reasoning, in either channel", () => {
    expect(locateCut(cut("", "let me think about this again and again"))).toEqual({ part: "reasoning" });
    expect(locateCut(cut("<think>first I will consider"))).toEqual({ part: "reasoning" });
  });

  it("a think-prefill prompt opened the block: unclosed text is reasoning (qwen-think on grammar)", () => {
    expect(
      locateCut(cut("Let me think about the layout again"), { openReasoning: true, closeTag: "</think>" }),
    ).toEqual({ part: "reasoning" });
    // Even when it starts like JSON: nothing closed the block.
    expect(locateCut(cut('{"maybe": the plan is'), { openReasoning: true })).toEqual({ part: "reasoning" });
    // Closed, the call after it is the cut.
    expect(
      locateCut(cut('plan</think>[{"tool":"os.fs.write","args":{"content":"ab'), { openReasoning: true }),
    ).toEqual({ part: "tool_call", tool: "os.fs.write" });
    // The server split the think block into its own channel: content is the body.
    expect(
      locateCut(cut('[{"tool":"os.fs.write","args":{"content":"ab', "long plan"), { openReasoning: true }),
    ).toEqual({ part: "tool_call", tool: "os.fs.write" });
  });

  it("reads the profile's own tags (gemma4-think channel)", () => {
    const gemma = { openReasoning: true, openTag: "<|channel>thought\n", closeTag: "<channel|>" };
    expect(locateCut(cut("<|channel>thought\nFirst I list the files, then"), gemma)).toEqual({ part: "reasoning" });
    expect(
      locateCut(cut('<|channel>thought\nok<channel|>[{"tool":"os.fs.write","args":{"content":"x'), gemma),
    ).toEqual({ part: "tool_call", tool: "os.fs.write" });
  });

  it("a cut answer is text, a grammar reply included", () => {
    expect(locateCut(cut("Here is the long answer you asked for"))).toEqual({ part: "text" });
    expect(locateCut(cut('[{"tool":"reply","args":{"text":"Here is'))).toEqual({ part: "text" });
    expect(locateCut(cut("", "", [{ name: "reply", arguments: '{"text":"Here' }]))).toEqual({ part: "text" });
    expect(locateCut(cut("<think>done</think>The answer is"))).toEqual({ part: "text" });
  });

  it("a name that is not a bounded identifier is left out, and nothing to read is null", () => {
    expect(locateCut(cut('[{"tool":"rm -rf / please","args":{')).toEqual({ part: "tool_call" });
    expect(locateCut(cut('{"path":"a"'))).toEqual({ part: "tool_call" });
    expect(locateCut(cut("   "))).toBeNull();
  });
});
