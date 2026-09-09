import { describe, it, expect } from "vitest";
import {
  PARSE_RECOVERY_BUDGET,
  composeParseFailureNotice,
  formatParseFailureNotice,
  formatTurnFailedRecord,
  isRecoverableParseFailure,
} from "./parse-failure-recovery.js";
import {
  GrammarError,
  ModelError,
  TransportError,
} from "../llm/reliability/llm-failures.js";
import { LlamaServerError } from "../llm/llama-server-client.js";
import { ToolCallParseError } from "../llm/grammar/tool-call-grammar.js";

describe("isRecoverableParseFailure", () => {
  it("accepts a completion body the parser rejected", () => {
    const cause = new ToolCallParseError(
      'tool call "os.fs.write" arguments are not a valid JSON object',
    );
    expect(
      isRecoverableParseFailure(new GrammarError(cause.message, "", { cause })),
    ).toBe(true);
  });

  it("accepts a bare parser error", () => {
    expect(
      isRecoverableParseFailure(new ToolCallParseError("tool-call body is empty")),
    ).toBe(true);
  });

  it("refuses a llama-server 4xx wearing the same GrammarError shape", () => {
    // `toLlmFailure` files a 400/413/422 as `GrammarError` too — but that
    // is the server rejecting the REQUEST, and another inference
    // reproduces it exactly. Recovering here would burn the budget and
    // then hand the operator the same diagnosis two steps later.
    const cause = new LlamaServerError("request too large", 413, "http://x/v1");
    expect(
      isRecoverableParseFailure(new GrammarError(cause.message, "", { cause })),
    ).toBe(false);
  });

  it("refuses failures from other categories", () => {
    expect(
      isRecoverableParseFailure(new TransportError("down", null, "http://x")),
    ).toBe(false);
    expect(
      isRecoverableParseFailure(new ModelError("truncated", "cut off")),
    ).toBe(false);
    expect(isRecoverableParseFailure(new Error("something else"))).toBe(false);
    expect(isRecoverableParseFailure("not an error")).toBe(false);
  });
});

describe("formatParseFailureNotice", () => {
  it("names the rejection, says nothing ran, and points at oversized arguments", () => {
    const notice = formatParseFailureNotice(
      'tool call "os.fs.write" arguments are not a valid JSON object',
    );
    expect(notice).toContain('tool call "os.fs.write" arguments are not a valid JSON object');
    expect(notice).toContain("Nothing you attempted has happened yet");
    expect(notice).toContain("split the work into several smaller calls");
  });

  it("clips a reason that quotes a slice of the model's output", () => {
    // V8 puts a fragment of the offending text into `JSON.parse`
    // messages, and that fragment is model output whose length the
    // runtime does not control.
    const long = `invalid tool-call JSON: Unexpected token 'x', "${"y".repeat(5_000)}" is not valid JSON`;
    const notice = formatParseFailureNotice(long);
    expect(notice.length).toBeLessThan(1_000);
    expect(notice).toContain("…");
  });

  it("collapses newlines so the notice stays one block", () => {
    expect(formatParseFailureNotice("line one\n\nline two")).toContain(
      "line one line two",
    );
  });
});

describe("composeParseFailureNotice", () => {
  it("is the whole notice when nothing else is pending", () => {
    const out = composeParseFailureNotice(undefined, "bad json");
    expect(out).toBe(formatParseFailureNotice("bad json"));
  });

  it("keeps what the step already owed the model, rejection first", () => {
    const out = composeParseFailureNotice("The user sent a new message", "bad json");
    expect(out).toContain("bad json");
    expect(out).toContain("The user sent a new message");
    expect(out.indexOf("bad json")).toBeLessThan(
      out.indexOf("The user sent a new message"),
    );
  });

  it("treats an empty existing notice as none", () => {
    expect(composeParseFailureNotice("", "bad json")).toBe(
      formatParseFailureNotice("bad json"),
    );
  });
});

describe("formatTurnFailedRecord", () => {
  it("reads as the turn's own account of why it produced nothing", () => {
    const row = formatTurnFailedRecord("grammar", 'tool call "os.fs.write" arguments are not a valid JSON object');
    expect(row).toContain("grammar");
    expect(row).toContain("os.fs.write");
    expect(row).toContain("Nothing from it took effect");
  });

  it("clips a runaway message", () => {
    expect(formatTurnFailedRecord("grammar", "z".repeat(5_000)).length).toBeLessThan(
      500,
    );
  });
});

describe("PARSE_RECOVERY_BUDGET", () => {
  it("is bounded", () => {
    expect(PARSE_RECOVERY_BUDGET).toBeGreaterThan(0);
    expect(PARSE_RECOVERY_BUDGET).toBeLessThanOrEqual(3);
  });
});
