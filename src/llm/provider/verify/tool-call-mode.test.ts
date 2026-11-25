import { describe, expect, it } from "vitest";

import {
  nativeToolReplyLooksMalformed,
  toolCallModeAfterProbe,
} from "./tool-call-mode.js";

const offeredNames = new Set(["os__fs__read", "reply"]);

function call(name: string, args: string) {
  return { function: { name, arguments: args } };
}

describe("toolCallModeAfterProbe", () => {
  it("keeps native tools for a route that proved a native call", () => {
    expect(toolCallModeAfterProbe("tools_supported")).toBe("native_tools");
    expect(toolCallModeAfterProbe("forced_tool_choice_rejected")).toBe(
      "native_tools",
    );
  });

  it("argues for the JSON reply when the tool-call contract itself broke", () => {
    expect(toolCallModeAfterProbe("malformed_tool_call")).toBe("json_schema");
    expect(toolCallModeAfterProbe("tools_payload_rejected")).toBe("json_schema");
    expect(toolCallModeAfterProbe("forced_tool_choice_ignored")).toBe(
      "json_schema",
    );
  });

  it("says nothing for verdicts that are not about tool calling", () => {
    for (const status of [
      "inconclusive_no_tool_call",
      "endpoint_auth_failed",
      "quota_or_routing_failed",
      "timeout",
      "unreachable",
      "stream_early_eof",
      "provider_error",
    ] as const) {
      expect(toolCallModeAfterProbe(status)).toBeNull();
    }
  });
});

describe("nativeToolReplyLooksMalformed", () => {
  it("accepts a dispatchable call, by wire or dotted name", () => {
    expect(
      nativeToolReplyLooksMalformed({
        toolCalls: [call("os__fs__read", '{"path":"a"}')],
        content: "",
        offeredNames,
      }),
    ).toBe(false);
    expect(
      nativeToolReplyLooksMalformed({
        toolCalls: [call("os.fs.read", "")],
        content: "",
        offeredNames,
      }),
    ).toBe(false);
  });

  it("flags a call with no name, an unoffered name or non-JSON arguments", () => {
    for (const bad of [
      call("", "{}"),
      call("os__fs__wipe", "{}"),
      call("os__fs__read", '{"path":'),
      call("os__fs__read", "[1]"),
    ]) {
      expect(
        nativeToolReplyLooksMalformed({
          toolCalls: [bad],
          content: "",
          offeredNames,
        }),
      ).toBe(true);
    }
  });

  it("flags tool-call markup the parser left in the reply text", () => {
    for (const content of [
      '[TOOL_CALLS]os__fs__read{"path":"a"}',
      '<tool_call>\n{"name":"os__fs__read"}',
      "<|python_tag|>os__fs__read(path='a')",
      '<function=os__fs__read>{"path":"a"}</function>',
      '{"name": "os__fs__read", "arguments": {"path": "a"}}',
    ]) {
      expect(
        nativeToolReplyLooksMalformed({ content, offeredNames }),
      ).toBe(true);
    }
  });

  it("does not flag a plain answer, one that quotes the syntax, or a cut reply", () => {
    expect(
      nativeToolReplyLooksMalformed({ content: "All done.", offeredNames }),
    ).toBe(false);
    expect(
      nativeToolReplyLooksMalformed({
        content: "Mistral writes calls as [TOOL_CALLS] followed by JSON.",
        offeredNames,
      }),
    ).toBe(false);
    expect(
      nativeToolReplyLooksMalformed({
        toolCalls: [call("os__fs__read", '{"path":')],
        content: "",
        offeredNames,
        finishReason: "length",
      }),
    ).toBe(false);
  });
});
