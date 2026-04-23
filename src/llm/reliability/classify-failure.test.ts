import { describe, it, expect } from "vitest";
import { LlamaServerError } from "../llama-server-client.js";
import { ToolCallParseError } from "../grammar/tool-call-grammar.js";
import {
  CancelledError,
  GrammarError,
  ModelError,
  ToolExecutionError,
  TransportError,
} from "./llm-failures.js";
import { classifyFailure } from "./classify-failure.js";

describe("classifyFailure", () => {
  it("returns the category of an LlmFailure instance directly", () => {
    expect(classifyFailure(new TransportError("x", null, "u"))).toBe("transport");
    expect(classifyFailure(new GrammarError("x", "y"))).toBe("grammar");
    expect(classifyFailure(new ModelError("empty", "x"))).toBe("model");
    expect(classifyFailure(new ToolExecutionError("t", "x"))).toBe("tool");
    expect(classifyFailure(new CancelledError())).toBe("cancelled");
  });

  it("maps LlamaServerError network errors to transport", () => {
    const err = new LlamaServerError("ECONNREFUSED", null, "http://x");
    expect(classifyFailure(err)).toBe("transport");
  });

  it("maps LlamaServerError 5xx to transport", () => {
    const err = new LlamaServerError("boom", 503, "http://x");
    expect(classifyFailure(err)).toBe("transport");
  });

  it("maps LlamaServerError 4xx to grammar", () => {
    const err = new LlamaServerError("bad grammar", 400, "http://x");
    expect(classifyFailure(err)).toBe("grammar");
  });

  it("maps ToolCallParseError to grammar", () => {
    expect(classifyFailure(new ToolCallParseError("bad json"))).toBe("grammar");
  });

  it("maps AbortError by name to cancelled", () => {
    const err = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(classifyFailure(err)).toBe("cancelled");
  });

  it("maps errors whose message mentions aborted to cancelled", () => {
    expect(classifyFailure(new Error("request was aborted"))).toBe("cancelled");
  });

  it("treats non-aborted plain Errors as tool failures", () => {
    expect(classifyFailure(new Error("unexpected"))).toBe("tool");
  });

  it("treats unknown values as tool failures", () => {
    expect(classifyFailure("not an error")).toBe("tool");
    expect(classifyFailure(42)).toBe("tool");
    expect(classifyFailure(undefined)).toBe("tool");
  });
});
