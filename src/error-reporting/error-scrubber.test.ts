import { describe, expect, it } from "vitest";

import {
  extractSafeCode,
  extractSafeReason,
  extractSafeTool,
  extractSafeFailureStage,
  extractSafeToolTransport,
  extractSafeTransportHost,
  extractSafeUpstreamErrorType,
  sanitizeStack,
  scrubError,
} from "./error-scrubber.js";

describe("sanitizeStack", () => {
  it("reduces filesystem paths to basenames (strips home dir / username)", () => {
    const stack = [
      "Error: boom",
      "    at doThing (/Users/aleksejkalina/code/app/cli.mjs:12:34)",
      "    at /Users/aleksejkalina/code/app/other.js:1:2",
      "    at process (node:internal/process/task_queues:95:5)",
    ].join("\n");
    const frames = sanitizeStack(stack);
    expect(frames).toEqual([
      { function: "doThing", filename: "cli.mjs", lineno: 12, colno: 34 },
      { filename: "other.js", lineno: 1, colno: 2 },
      {
        function: "process",
        filename: "node:internal/process/task_queues",
        lineno: 95,
        colno: 5,
      },
    ]);
    // No frame leaks the absolute path / username.
    for (const f of frames) {
      expect(f.filename).not.toContain("aleksejkalina");
      expect(f.filename).not.toContain("/Users/");
    }
  });

  it("returns an empty array for a missing stack", () => {
    expect(sanitizeStack(undefined)).toEqual([]);
  });
});

describe("extractSafeCode", () => {
  it("pulls http status and errno-style code, ignores freeform fields", () => {
    expect(extractSafeCode({ status: 503, code: "ECONNREFUSED" })).toEqual({
      httpStatus: 503,
      code: "ECONNREFUSED",
    });
    // A non-enum `code` (could contain user data) is dropped.
    expect(extractSafeCode({ code: "failed to read /home/x" })).toEqual({});
    expect(extractSafeCode(null)).toEqual({});
  });

  it("reads status and errno through the wrapper chain", () => {
    // What actually reaches the scrubber: TransportError wrapping a
    // LlamaServerError wrapping undici's TypeError. Only the innermost
    // link knows it was a refused connection.
    const undici = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      }),
    });
    const llama = Object.assign(new Error("network"), {
      name: "LlamaServerError",
      status: null,
      cause: undici,
    });
    const transport = Object.assign(new Error("network"), {
      name: "TransportError",
      cause: llama,
    });
    expect(extractSafeCode(transport)).toEqual({ code: "ECONNREFUSED" });
  });

  it("prefers a status the wrapper carries over its cause's", () => {
    const cause = Object.assign(new Error("inner"), { status: 500 });
    const wrapper = Object.assign(new Error("outer"), { status: 404, cause });
    expect(extractSafeCode(wrapper)).toEqual({ httpStatus: 404 });
  });

  it("back-fills the status a GrammarError wrapper does not carry", () => {
    // GrammarError has no status field at all, which is why not one
    // grammar issue in Sentry has an `http_status` tag today.
    const llama = Object.assign(new Error("http 501"), {
      name: "LlamaServerError",
      status: 501,
    });
    const grammar = Object.assign(new Error("rejected"), {
      name: "GrammarError",
      cause: llama,
    });
    expect(extractSafeCode(grammar)).toEqual({ httpStatus: 501 });
  });

  it("survives a self-referential cause chain", () => {
    const err = new Error("loop") as Error & { cause?: unknown };
    err.cause = err;
    expect(extractSafeCode(err)).toEqual({});
  });
});

describe("extractSafeReason", () => {
  it("allows the known ModelFailureReason enum values", () => {
    expect(extractSafeReason({ reason: "truncated" })).toBe("truncated");
    expect(extractSafeReason({ reason: "empty" })).toBe("empty");
    expect(extractSafeReason({ reason: "no_stop" })).toBe("no_stop");
  });

  it("drops an unrecognised reason (could be freeform text)", () => {
    expect(
      extractSafeReason({ reason: "user typed something weird" }),
    ).toBeUndefined();
    expect(extractSafeReason(null)).toBeUndefined();
  });
});

describe("extractSafeToolTransport", () => {
  it("allows the known ToolCallTransport enum values", () => {
    expect(extractSafeToolTransport({ transport: "grammar" })).toBe("grammar");
    expect(extractSafeToolTransport({ transport: "native_tools" })).toBe(
      "native_tools",
    );
  });

  it("drops an unrecognised transport (could be freeform text)", () => {
    expect(
      extractSafeToolTransport({ transport: "grammar for /Users/alex/x.txt" }),
    ).toBeUndefined();
    expect(extractSafeToolTransport({ transport: "" })).toBeUndefined();
    expect(extractSafeToolTransport({ transport: 7 })).toBeUndefined();
    expect(extractSafeToolTransport({})).toBeUndefined();
    expect(extractSafeToolTransport(null)).toBeUndefined();
  });
});

describe("extractSafeFailureStage", () => {
  it("allows the known ModelFailureStage enum values", () => {
    expect(extractSafeFailureStage({ stage: "initial" })).toBe("initial");
    expect(extractSafeFailureStage({ stage: "repair" })).toBe("repair");
  });

  it("drops an unrecognised stage (could be freeform text)", () => {
    expect(
      extractSafeFailureStage({ stage: "repair of /Users/alex/x.txt" }),
    ).toBeUndefined();
    expect(extractSafeFailureStage({ stage: "" })).toBeUndefined();
    expect(extractSafeFailureStage({ stage: 2 })).toBeUndefined();
    expect(extractSafeFailureStage({})).toBeUndefined();
    expect(extractSafeFailureStage(null)).toBeUndefined();
  });
});

describe("extractSafeTool", () => {
  it("allows a bounded registry-style tool identifier", () => {
    expect(extractSafeTool({ tool: "os.fs.read" })).toBe("os.fs.read");
    expect(extractSafeTool({ tool: "unknown" })).toBe("unknown");
  });

  it("drops a tool value that is not a bounded identifier (could echo model output)", () => {
    expect(
      extractSafeTool({ tool: "please read /Users/alex/notes.txt" }),
    ).toBeUndefined();
    expect(extractSafeTool({ tool: "a".repeat(65) })).toBeUndefined();
  });
});

describe("extractSafeTransportHost", () => {
  it("sends a host class, never the host, path or query", () => {
    expect(
      extractSafeTransportHost({ url: "http://127.0.0.1:8080/completion?x=1" }),
    ).toBe("localhost");
    expect(
      extractSafeTransportHost({ url: "https://llm.acme-corp.com/v1" }),
    ).toBe("other");
  });

  it("drops a malformed url", () => {
    expect(extractSafeTransportHost({ url: "not a url" })).toBeUndefined();
    expect(extractSafeTransportHost({})).toBeUndefined();
  });
});

describe("extractSafeUpstreamErrorType", () => {
  it("keeps the enum-shaped types llama.cpp and OpenAI actually send", () => {
    for (const type of [
      "exceed_context_size_error",
      "invalid_request_error",
      "server_error",
      "unavailable_error",
      "insufficient_quota",
    ]) {
      expect(extractSafeUpstreamErrorType({ body: { type } })).toBe(type);
    }
  });

  it("drops freeform server text — the whole point of the allowlist", () => {
    // Everything a local server is free to put in `error.type`, and
    // exactly what must never reach Sentry. Dropped, never truncated:
    // the first 48 characters of a prompt are still the user's prompt.
    const hostile = [
      "the request exceeds the available context size, try increasing it",
      "/Users/alex/notes/salary-negotiation.md",
      "C:\\Users\\alex\\Documents\\passwords.txt",
      "превышен размер контекста",
      "Error: invalid_request",
      "a".repeat(500),
      "exceed_context_size_error ", // trailing space is not the enum
      // A capital anywhere is out, including the all-caps constant name
      // llama.cpp uses internally (`ERROR_TYPE_EXCEED_CONTEXT_SIZE`) —
      // the enum on the wire is lowercase, and `[A-Z]` is the cheapest
      // way for prose to sneak past a snake_case pattern.
      "EXCEED_CONTEXT_SIZE_ERROR",
      "Exceed_Context_Size_Error",
    ];
    for (const type of hostile) {
      expect(extractSafeUpstreamErrorType({ body: { type } })).toBeUndefined();
    }
  });

  it("keeps a 48-character type and drops a 49-character one", () => {
    // The bound is the reason a prompt fragment cannot arrive truncated
    // to something that still reads as one: pin both sides of it, or a
    // widened bound goes unnoticed.
    expect(
      extractSafeUpstreamErrorType({ body: { type: "a".repeat(48) } }),
    ).toBe("a".repeat(48));
    expect(
      extractSafeUpstreamErrorType({ body: { type: "a".repeat(49) } }),
    ).toBeUndefined();
  });

  it("drops a non-string type instead of coercing it", () => {
    // `String(["exceed_context_size_error"])` is a *valid* type — an
    // array is how a coercing check quietly accepts a caller-controlled
    // value it never validated. The check is `typeof type === "string"`,
    // and these pin that.
    for (const type of [
      123,
      {},
      ["exceed_context_size_error"],
      Symbol("exceed_context_size_error"),
      true,
      null,
    ]) {
      expect(extractSafeUpstreamErrorType({ body: { type } })).toBeUndefined();
    }
  });

  it("reads through the wrapper to the cause that carries the body", () => {
    // The scrubbed error is the `TransportError` wrapper `toLlmFailure`
    // builds; it copies `status`/`url` but not the parsed body, so
    // reading only the top object finds nothing.
    const cause = { body: { type: "exceed_context_size_error", text: "…" } };
    expect(extractSafeUpstreamErrorType({ status: 400, cause })).toBe(
      "exceed_context_size_error",
    );
  });

  it("ignores a non-object body and a missing one", () => {
    expect(extractSafeUpstreamErrorType({ body: "boom" })).toBeUndefined();
    expect(extractSafeUpstreamErrorType({ body: null })).toBeUndefined();
    expect(extractSafeUpstreamErrorType({})).toBeUndefined();
    expect(extractSafeUpstreamErrorType(null)).toBeUndefined();
  });

  it("stops at the depth cap rather than walking an unbounded chain", () => {
    // `MAX_CAUSE_DEPTH` is what terminates this walk, so that is what
    // gets asserted: a valid type one link past the cap is not reached.
    // The `next === current` break mirrors the sibling walk in
    // `readHttpStatusAndCode` and keeps the intent local, but it is not
    // independently observable through the return value — the cap already
    // ends a self-referential chain, which the last case pins.
    const chain = (depth: number): unknown =>
      depth === 0
        ? { body: { type: "exceed_context_size_error" } }
        : { cause: chain(depth - 1) };
    expect(extractSafeUpstreamErrorType(chain(4))).toBe(
      "exceed_context_size_error",
    );
    expect(extractSafeUpstreamErrorType(chain(5))).toBeUndefined();
    const cycle: { body?: unknown; cause?: unknown } = {};
    cycle.cause = cycle;
    expect(extractSafeUpstreamErrorType(cycle)).toBeUndefined();
  });
});

describe("scrubError", () => {
  it("omits the raw message by default (allowlist policy)", () => {
    const err = new Error("failed reading /Users/alex/secret.txt");
    err.name = "TypeError";
    const ev = scrubError(err, { source: "uncaughtException" });
    expect(ev.errorType).toBe("TypeError");
    expect(ev.message).toBeUndefined();
    expect(ev.source).toBe("uncaughtException");
  });

  it("reads a known LLM category off the error", () => {
    const err = Object.assign(new Error("transport boom"), {
      name: "TransportError",
      category: "transport",
      status: 502,
    });
    const ev = scrubError(err, { source: "llm_failure" });
    expect(ev.category).toBe("transport");
    expect(ev.httpStatus).toBe(502);
    expect(ev.message).toBeUndefined();
  });

  it("prefers the explicit category override", () => {
    const err = new Error("x");
    const ev = scrubError(err, { source: "llm_failure", category: "grammar" });
    expect(ev.category).toBe("grammar");
  });

  it("carries ModelError.reason through when it is a known enum value", () => {
    const err = Object.assign(new Error("cut off"), {
      name: "ModelError",
      category: "model",
      reason: "truncated",
    });
    const ev = scrubError(err, { source: "llm_failure" });
    expect(ev.reason).toBe("truncated");
  });

  it("carries ModelError.transport through when it is a known enum value", () => {
    const err = Object.assign(new Error("empty completion"), {
      name: "ModelError",
      category: "model",
      reason: "empty",
      transport: "native_tools",
    });
    const ev = scrubError(err, { source: "llm_failure" });
    expect(ev.reason).toBe("empty");
    expect(ev.toolTransport).toBe("native_tools");
  });

  it("drops a bogus ModelError.transport rather than reporting it", () => {
    const err = Object.assign(new Error("empty completion"), {
      name: "ModelError",
      category: "model",
      reason: "empty",
      transport: "totally made up /Users/alex",
    });
    const ev = scrubError(err, { source: "llm_failure" });
    expect(ev.reason).toBe("empty");
    expect(ev.toolTransport).toBeUndefined();
  });

  it("carries ModelError.stage through when it is a known enum value", () => {
    // The axis `transport` does not cover: the same reason=empty +
    // transport=native_tools pair is raised both by the by-design
    // first-attempt route and after a repair that came back empty.
    const err = Object.assign(new Error("empty completion"), {
      name: "ModelError",
      category: "model",
      reason: "empty",
      transport: "native_tools",
      stage: "repair",
    });
    const ev = scrubError(err, { source: "llm_failure" });
    expect(ev.toolTransport).toBe("native_tools");
    expect(ev.failureStage).toBe("repair");
  });

  it("drops a bogus ModelError.stage rather than reporting it", () => {
    const err = Object.assign(new Error("empty completion"), {
      name: "ModelError",
      category: "model",
      reason: "empty",
      stage: "stage 3 of /Users/alex/session.json",
    });
    const ev = scrubError(err, { source: "llm_failure" });
    expect(ev.reason).toBe("empty");
    expect(ev.failureStage).toBeUndefined();
  });

  it("carries ToolExecutionError.tool through when it is a bounded identifier", () => {
    const err = Object.assign(new Error("boom"), {
      name: "ToolExecutionError",
      category: "tool",
      tool: "os.shell.run",
    });
    const ev = scrubError(err, { source: "llm_failure" });
    expect(ev.tool).toBe("os.shell.run");
  });

  it("carries only the class of TransportError's url host", () => {
    const err = Object.assign(new Error("net down"), {
      name: "TransportError",
      category: "transport",
      status: null,
      url: "http://localhost:8080/completion",
    });
    const ev = scrubError(err, { source: "llm_failure" });
    expect(ev.transportHost).toBe("localhost");
  });

  it("prefers the cause's stack over the wrapper's own stack", () => {
    function throwOriginal(): never {
      throw new TypeError("cannot read x of undefined");
    }
    let cause: Error;
    try {
      throwOriginal();
      throw new Error("unreachable");
    } catch (err) {
      cause = err as Error;
    }
    const wrapper = Object.assign(new Error("ToolExecutionError"), {
      name: "ToolExecutionError",
      category: "tool",
      tool: "unknown",
      cause,
    });
    const ev = scrubError(wrapper, { source: "llm_failure" });
    // The wrapper's own stack would only ever show the `scrubError` test
    // call site, never `throwOriginal` — this pins that the cause's frame
    // (where the real failure happened) wins.
    expect(ev.frames.some((f) => f.function === "throwOriginal")).toBe(true);
  });

  it("falls back to the wrapper's own stack when cause is not an Error", () => {
    const err = Object.assign(new Error("boom"), {
      name: "ToolExecutionError",
      cause: "a plain string cause, not an Error",
    });
    const ev = scrubError(err, { source: "llm_failure" });
    expect(ev.causeType).toBeUndefined();
    expect(ev.frames).toEqual(sanitizeStack(err.stack));
  });

  it("surfaces the cause's class name as causeType, distinct from the wrapper's errorType", () => {
    const cause = new RangeError("out of bounds");
    const wrapper = Object.assign(new Error("ToolExecutionError"), {
      name: "ToolExecutionError",
      cause,
    });
    const ev = scrubError(wrapper, { source: "llm_failure" });
    expect(ev.errorType).toBe("ToolExecutionError");
    expect(ev.causeType).toBe("RangeError");
  });

  it("omits causeType when the error has no cause", () => {
    const err = new Error("plain failure");
    const ev = scrubError(err, { source: "uncaughtException" });
    expect(ev.causeType).toBeUndefined();
  });

  it("falls back to the wrapper's frames when the cause has none", () => {
    // A cause with an unparseable stack used to take the wrapper's
    // frames down with it and ship an event with NO stack at all — how
    // a 108-event issue ended up undiagnosable.
    const cause = new Error("fetch failed");
    cause.stack = "TypeError: fetch failed";
    const wrapper = Object.assign(new Error("wrapped"), {
      name: "ToolExecutionError",
      cause,
    });
    wrapper.stack = [
      "ToolExecutionError: wrapped",
      "    at toLlmFailure (/app/step-executor.js:1561:10)",
      "    at executeStep (/app/step-executor.js:303:20)",
    ].join("\n");
    const ev = scrubError(wrapper, { source: "llm_failure" });
    expect(ev.frames.map((f) => f.filename)).toEqual([
      "step-executor.js",
      "step-executor.js",
    ]);
  });

  it("still prefers the cause's frames when it has them", () => {
    const cause = new Error("boom");
    cause.stack = [
      "Error: boom",
      "    at realThrowSite (/app/prime-stream.js:24:3)",
    ].join("\n");
    const wrapper = Object.assign(new Error("wrapped"), { cause });
    wrapper.stack = [
      "Error: wrapped",
      "    at wrapIt (/app/step-executor.js:1561:10)",
    ].join("\n");
    const ev = scrubError(wrapper, { source: "llm_failure" });
    expect(ev.frames.map((f) => f.filename)).toEqual(["prime-stream.js"]);
  });

  it("carries the upstream error type off the provider error underneath", () => {
    const cause = Object.assign(new Error("openai provider 400: …"), {
      name: "OpenAiHttpError",
      status: 400,
      body: {
        type: "exceed_context_size_error",
        message:
          "request (14612 tokens) exceeds the available context size (12800 tokens), try increasing it",
        text: '{"error":{"code":400,"message":"request (14612 tokens) …"}}',
      },
    });
    const wrapper = Object.assign(new Error("humanized"), {
      name: "TransportError",
      status: 400,
      url: "http://127.0.0.1:8095/v1/chat/completions",
      cause,
    });
    const ev = scrubError(wrapper, {
      source: "llm_failure",
      category: "transport",
    });
    expect(ev.upstreamErrorType).toBe("exceed_context_size_error");
    // The body's prose and raw text stay behind: only `.type` travels.
    expect(JSON.stringify(ev)).not.toContain("14612");
    expect(JSON.stringify(ev)).not.toContain("exceeds the available");
  });

  it("omits the upstream error type when the body's is freeform", () => {
    const cause = Object.assign(new Error("boom"), {
      name: "OpenAiHttpError",
      status: 400,
      body: { type: "prompt too long: 'draft my resignation letter'" },
    });
    const wrapper = Object.assign(new Error("humanized"), {
      name: "TransportError",
      cause,
    });
    const ev = scrubError(wrapper, { source: "llm_failure" });
    expect(ev.upstreamErrorType).toBeUndefined();
    expect(JSON.stringify(ev)).not.toContain("resignation");
  });
});
