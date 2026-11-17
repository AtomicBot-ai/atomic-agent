import { describe, expect, it } from "vitest";

import type { BenchCase } from "./bench-cases.js";
import { scoreToolCall } from "./score-tool-call.js";

const EMAIL: BenchCase = {
  id: "send-email",
  prompt: "email anna",
  expectedTool: "send_email",
  requiredArgs: ["to", "subject", "body"],
};

const call = (name: string, args: string) => ({
  content: "",
  toolCalls: [{ type: "function" as const, function: { name, arguments: args } }],
});

describe("scoreToolCall (ATO-1092)", () => {
  it("is ok for the right tool with every required argument", () => {
    const reply = call("send_email", JSON.stringify({ to: "a@b.c", subject: "Lunch", body: "noon" }));
    expect(scoreToolCall(EMAIL, reply)).toEqual({ outcome: "ok", calledTool: "send_email" });
  });

  it("is no_call when the model only answered in text", () => {
    expect(scoreToolCall(EMAIL, { content: "Sure, I sent it." })).toEqual({ outcome: "no_call" });
    expect(scoreToolCall(EMAIL, { content: "", toolCalls: [] }).outcome).toBe("no_call");
  });

  it("is parse_failure for arguments that are not a JSON object", () => {
    expect(scoreToolCall(EMAIL, call("send_email", "{to: anna")).outcome).toBe("parse_failure");
    expect(scoreToolCall(EMAIL, call("send_email", "[1,2]")).outcome).toBe("parse_failure");
    expect(scoreToolCall(EMAIL, call("send_email", "null")).outcome).toBe("parse_failure");
  });

  it("is wrong_tool for valid JSON on another tool", () => {
    expect(scoreToolCall(EMAIL, call("web_search", '{"query":"anna"}'))).toEqual({
      outcome: "wrong_tool",
      calledTool: "web_search",
    });
  });

  it("is missing_args and names what is missing, counting blank strings as missing", () => {
    expect(scoreToolCall(EMAIL, call("send_email", '{"to":"a@b.c","subject":"  "}'))).toEqual({
      outcome: "missing_args",
      calledTool: "send_email",
      missingArgs: ["subject", "body"],
    });
  });

  it("reads an empty arguments string as an empty object", () => {
    expect(scoreToolCall(EMAIL, call("send_email", "")).outcome).toBe("missing_args");
  });

  it("scores only the first call", () => {
    const reply = {
      content: "",
      toolCalls: [
        { function: { name: "web_search", arguments: '{"query":"x"}' } },
        { function: { name: "send_email", arguments: '{"to":"a","subject":"b","body":"c"}' } },
      ],
    };
    expect(scoreToolCall(EMAIL, reply).outcome).toBe("wrong_tool");
  });
});
