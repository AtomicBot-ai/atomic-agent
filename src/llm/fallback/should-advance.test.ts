import { describe, it, expect } from "vitest";
import { shouldAdvance } from "./should-advance.js";
import { OpenAiHttpError } from "../provider/openai/openai-http.js";
import { LlamaServerError } from "../llama-server-client.js";
import {
  TransportError,
  GrammarError,
  ModelError,
  ToolExecutionError,
  CancelledError,
} from "../reliability/llm-failures.js";

describe("shouldAdvance", () => {
  it("advances immediately on a cloud 429", () => {
    expect(shouldAdvance(new OpenAiHttpError("x", 429, "u"))).toEqual({
      advance: true,
      immediate: true,
    });
  });

  it("advances immediately on any cloud 5xx", () => {
    expect(shouldAdvance(new OpenAiHttpError("x", 503, "u"))).toEqual({
      advance: true,
      immediate: true,
    });
  });

  it("advances immediately on a 408 request timeout status", () => {
    expect(shouldAdvance(new OpenAiHttpError("x", 408, "u"))).toEqual({
      advance: true,
      immediate: true,
    });
  });

  it("advances immediately on a network-level failure (status null, not our timeout)", () => {
    expect(shouldAdvance(new OpenAiHttpError("x", null, "u", false))).toEqual({
      advance: true,
      immediate: true,
    });
  });

  it("advances but NOT immediately on our own request timeout", () => {
    expect(shouldAdvance(new OpenAiHttpError("x", null, "u", true))).toEqual({
      advance: true,
      immediate: false,
    });
  });

  it("advances but NOT immediately on a local llama request timeout", () => {
    // Symmetric with the cloud case above: our own request-timeout
    // controller firing (status === null, timedOut) is weak evidence and
    // must only count toward the threshold — never an immediate switch,
    // which would replay and burn another full timeout of GPU time.
    expect(
      shouldAdvance(new LlamaServerError("x", null, "http://local", true)),
    ).toEqual({
      advance: true,
      immediate: false,
    });
  });

  it("advances (transport) on a cloud 401 — a dead key should try the fallback", () => {
    // OpenAiHttpError is always transport-category; 401 is not an
    // immediate provider-down signal, so it advances via the threshold.
    expect(shouldAdvance(new OpenAiHttpError("x", 401, "u"))).toEqual({
      advance: true,
      immediate: false,
    });
  });

  it("advances immediately on a local llama 5xx", () => {
    expect(shouldAdvance(new LlamaServerError("x", 502, "http://local"))).toEqual({
      advance: true,
      immediate: true,
    });
  });

  it("does NOT advance on a local llama 4xx (grammar category)", () => {
    // LlamaServerError with a 4xx status classifies as grammar.
    expect(shouldAdvance(new LlamaServerError("x", 400, "http://local"))).toEqual({
      advance: false,
      immediate: false,
    });
  });

  it("advances via threshold on a TransportError carrying null status", () => {
    expect(shouldAdvance(new TransportError("x", null, "u"))).toEqual({
      advance: true,
      immediate: true,
    });
  });

  it("advances (model) but not immediately on a ModelError", () => {
    expect(shouldAdvance(new ModelError("empty", "no output"))).toEqual({
      advance: true,
      immediate: false,
    });
  });

  it("does not advance on a grammar error", () => {
    expect(shouldAdvance(new GrammarError("x", ""))).toEqual({
      advance: false,
      immediate: false,
    });
  });

  it("does not advance on a tool error", () => {
    expect(shouldAdvance(new ToolExecutionError("some.tool", "x"))).toEqual({
      advance: false,
      immediate: false,
    });
  });

  it("does not advance on a cancellation", () => {
    expect(shouldAdvance(new CancelledError("x"))).toEqual({
      advance: false,
      immediate: false,
    });
  });
});
