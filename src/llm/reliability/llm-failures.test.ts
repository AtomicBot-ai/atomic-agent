import { describe, it, expect } from "vitest";
import {
  CancelledError,
  GrammarError,
  LlmFailure,
  ModelError,
  ToolExecutionError,
  TransportError,
} from "./llm-failures.js";

describe("LlmFailure subclasses", () => {
  it("pins a category on every concrete subclass", () => {
    expect(new TransportError("net down", null, "http://x").category).toBe(
      "transport",
    );
    expect(new GrammarError("bad json", "raw").category).toBe("grammar");
    expect(new ModelError("truncated", "cut off").category).toBe("model");
    expect(new ToolExecutionError("shell", "boom").category).toBe("tool");
    expect(new CancelledError().category).toBe("cancelled");
  });

  it("all subclasses extend LlmFailure and Error", () => {
    const errors: LlmFailure[] = [
      new TransportError("x", 500, "u"),
      new GrammarError("x", "y"),
      new ModelError("empty", "x"),
      new ToolExecutionError("t", "x"),
      new CancelledError(),
    ];
    for (const err of errors) {
      expect(err).toBeInstanceOf(LlmFailure);
      expect(err).toBeInstanceOf(Error);
      expect(typeof err.message).toBe("string");
    }
  });

  it("preserves specialized fields on each subclass", () => {
    const transport = new TransportError("net", 503, "http://host/completion");
    expect(transport.status).toBe(503);
    expect(transport.url).toBe("http://host/completion");

    const grammar = new GrammarError("bad", "{\"tool\":...");
    expect(grammar.rawPreview).toBe("{\"tool\":...");

    const model = new ModelError("no_stop", "ran away");
    expect(model.reason).toBe("no_stop");

    const tool = new ToolExecutionError("shell", "missing");
    expect(tool.tool).toBe("shell");
  });

  it("propagates cause when provided", () => {
    const cause = new Error("underlying");
    const err = new GrammarError("wrapped", "raw", { cause });
    expect((err as { cause?: unknown }).cause).toBe(cause);
  });

  it("CancelledError defaults to a readable message", () => {
    const err = new CancelledError();
    expect(err.message).toBe("operation cancelled");
  });

  it("sets the class name for each subclass", () => {
    expect(new TransportError("x", null, "u").name).toBe("TransportError");
    expect(new GrammarError("x", "y").name).toBe("GrammarError");
    expect(new ModelError("empty", "x").name).toBe("ModelError");
    expect(new ToolExecutionError("t", "x").name).toBe("ToolExecutionError");
    expect(new CancelledError().name).toBe("CancelledError");
  });
});
