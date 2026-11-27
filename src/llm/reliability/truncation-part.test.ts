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
