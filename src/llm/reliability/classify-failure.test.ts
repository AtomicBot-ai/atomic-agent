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
import {
  SubscriptionCliAuthError,
  SubscriptionCliInvocationError,
  SubscriptionCliNotInstalledError,
} from "../provider/subscription-cli/subscription-cli-errors.js";
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

  it("maps LlamaServerError request-shape 4xx to grammar", () => {
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

describe("classifyFailure — raw network failures", () => {
  it("maps undici's `fetch failed` to transport, not tool", () => {
    const inner = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:19091"), {
      code: "ECONNREFUSED",
    });
    const err = Object.assign(new TypeError("fetch failed"), { cause: inner });
    expect(classifyFailure(err)).toBe("transport");
  });

  it("maps a socket that died mid-body to transport", () => {
    expect(classifyFailure(new Error("terminated"))).toBe("transport");
    expect(classifyFailure(new Error("socket hang up"))).toBe("transport");
  });

  it("still treats a genuine runtime bug as a tool failure", () => {
    expect(classifyFailure(new TypeError("x.map is not a function"))).toBe(
      "tool",
    );
  });

  it("keeps cancellation ahead of the network branch", () => {
    // An aborted request surfaces as ECONNRESET; user intent still wins.
    const err = Object.assign(new Error("The operation was aborted"), {
      name: "AbortError",
      code: "ECONNRESET",
    });
    expect(classifyFailure(err)).toBe("cancelled");
  });
});

describe("classifyFailure — llama-server HTTP statuses", () => {
  // A 4xx that describes the *endpoint* must not be filed as `grammar`:
  // that category blocks fallover (`shouldAdvance`) and tells the user
  // their grammar is broken when the real answer is "that URL is not a
  // llama-server". A 4xx that rejects the request itself stays grammar.
  const cases: Array<[number | null, string]> = [
    [null, "transport"],
    [400, "grammar"],
    [401, "transport"],
    [402, "transport"],
    [403, "transport"],
    [404, "transport"],
    [405, "transport"],
    [408, "transport"],
    [409, "transport"],
    [413, "grammar"],
    [422, "grammar"],
    [429, "transport"],
    [500, "transport"],
    [503, "transport"],
  ];

  for (const [status, expected] of cases) {
    it(`maps status ${status ?? "null"} to ${expected}`, () => {
      const err = new LlamaServerError("boom", status, "http://x");
      expect(classifyFailure(err)).toBe(expected);
    });
  }

  it("leaves an unlisted 4xx on the request-shape side", () => {
    // Conservative default: only the statuses we can name as
    // endpoint/auth/availability earn a fallover.
    expect(classifyFailure(new LlamaServerError("x", 418, "http://x"))).toBe(
      "grammar",
    );
  });
});

describe("classifyFailure — subscription-CLI providers", () => {
  it("maps a missing CLI binary to transport, not tool", () => {
    // "claude is not on PATH" is a dead provider link, not a bug in our
    // tool layer — the chain must be free to try the next provider.
    const err = new SubscriptionCliNotInstalledError("claude", "Install it.");
    expect(classifyFailure(err)).toBe("transport");
  });

  it("maps a signed-out CLI to transport, not tool", () => {
    const err = new SubscriptionCliAuthError("codex", "Run /login.");
    expect(classifyFailure(err)).toBe("transport");
  });

  it("still treats a failed CLI invocation as a tool failure", () => {
    // The binary ran and came back unhappy: that is not evidence the
    // link is unusable, so it keeps the non-advancing category.
    const err = new SubscriptionCliInvocationError("claude exited 1", 1);
    expect(classifyFailure(err)).toBe("tool");
  });
});
