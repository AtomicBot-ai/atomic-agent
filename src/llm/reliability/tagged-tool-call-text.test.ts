import { describe, expect, it } from "vitest";

import {
  countTaggedToolCallBlocks,
  detectTaggedToolCallText,
} from "./tagged-tool-call-text.js";

// The block from GitHub #999, with a tool name nothing offers.
const ISSUE_BLOCK = [
  "<tool_call>",
  "<function=os.web__search>",
  "<parameter=maxResults>",
  "10",
  "</parameter>",
  "<parameter=query>",
  "test",
  "</parameter>",
  "</function>",
  "</tool_call>",
].join("\n");

describe("countTaggedToolCallBlocks (GitHub #999)", () => {
  it("counts the Qwen block from the issue once, not once per tag line", () => {
    expect(countTaggedToolCallBlocks(ISSUE_BLOCK)).toBe(1);
  });

  it.each([
    [
      "an unclosed tag at the end of the stream",
      "<tool_call>\n<function=os.web__search>\n<parameter=query>\ntest",
    ],
    [
      "a Hermes block with broken JSON",
      '<tool_call>\n{"name": "os__web__search", "arguments": {"query": \n</tool_call>',
    ],
    [
      "a one-line Hermes block for an unknown tool",
      '<tool_call>{"name": "os.web.serch", "arguments": {}}</tool_call>',
    ],
    ["a block after a line of prose", `Let me search for that.\n${ISSUE_BLOCK}`],
    [
      "a bare function header without the outer tag",
      "<function=os.fs__read>\n<parameter=path>\na.txt\n</parameter>\n</function>",
    ],
    ["an indented block", `  ${ISSUE_BLOCK.split("\n").join("\n  ")}`],
    ["a block inside a fence that never closes", `Running:\n\`\`\`\n${ISSUE_BLOCK}`],
  ])("counts %s", (_label, text) => {
    expect(countTaggedToolCallBlocks(text)).toBe(1);
  });

  it("counts every block", () => {
    expect(countTaggedToolCallBlocks(`${ISSUE_BLOCK}\n${ISSUE_BLOCK}`)).toBe(2);
    expect(
      countTaggedToolCallBlocks(
        "<function=a>\n</function>\n<function=b>\n</function>",
      ),
    ).toBe(2);
  });

  it.each([
    ["plain prose", "The search found three results."],
    [
      "a tag mentioned mid-line",
      "Qwen wraps each call in a <tool_call> tag and a <function=NAME> header.",
    ],
    [
      "a block quoted in a closed fence",
      `Qwen writes a call like this:\n\`\`\`xml\n${ISSUE_BLOCK}\n\`\`\`\nThat is the format.`,
    ],
    [
      "a block quoted in a closed tilde fence",
      `~~~\n${ISSUE_BLOCK}\n~~~`,
    ],
    ["an empty text", ""],
  ])("ignores %s", (_label, text) => {
    expect(countTaggedToolCallBlocks(text)).toBeNull();
  });

  it("still counts a live block after a closed fence that quoted one", () => {
    const text = `Example:\n\`\`\`\n${ISSUE_BLOCK}\n\`\`\`\nNow for real:\n${ISSUE_BLOCK}`;
    expect(countTaggedToolCallBlocks(text)).toBe(1);
  });
});

describe("detectTaggedToolCallText", () => {
  it("reports the blocks in the transcript-check shape", () => {
    expect(detectTaggedToolCallText(ISSUE_BLOCK)).toEqual({
      calls: 1,
      results: 0,
      taggedBlocks: 1,
    });
  });

  it("returns null for text without a live block", () => {
    expect(detectTaggedToolCallText("All done.")).toBeNull();
  });
});
