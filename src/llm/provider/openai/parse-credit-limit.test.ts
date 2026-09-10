import { describe, it, expect } from "vitest";

import { parseCreditLimit } from "./parse-credit-limit.js";

/** The exact body a real OpenRouter 402 carried in the reported session. */
const REAL_BODY =
  "This request requires more credits, or fewer max_tokens. You requested " +
  "up to 65536 tokens, but can only afford 45822.";

describe("parseCreditLimit", () => {
  it("reads both counts out of the real OpenRouter refusal", () => {
    expect(parseCreditLimit(REAL_BODY)).toEqual({
      requested: 65536,
      affordable: 45822,
    });
  });

  it("reads them out of the JSON envelope the client actually receives", () => {
    const body = JSON.stringify({
      error: { code: 402, message: REAL_BODY },
    });
    expect(parseCreditLimit(body)).toEqual({
      requested: 65536,
      affordable: 45822,
    });
  });

  it("survives the client's own message prefix", () => {
    expect(parseCreditLimit(`openai provider 402: ${REAL_BODY}`)).toEqual({
      requested: 65536,
      affordable: 45822,
    });
  });

  it("accepts thousands separators in the counts", () => {
    expect(
      parseCreditLimit("You requested up to 65,536 tokens, but can only afford 45,822."),
    ).toEqual({ requested: 65536, affordable: 45822 });
  });

  it("is case-insensitive", () => {
    expect(
      parseCreditLimit("YOU REQUESTED UP TO 4096 TOKENS, BUT CAN ONLY AFFORD 512."),
    ).toEqual({ requested: 4096, affordable: 512 });
  });

  it("returns null when the affordable count is not smaller", () => {
    expect(
      parseCreditLimit("You requested up to 1000 tokens, but can only afford 1000."),
    ).toBeNull();
    expect(
      parseCreditLimit("You requested up to 1000 tokens, but can only afford 2000."),
    ).toBeNull();
  });

  it("returns null when only one of the two anchors is present", () => {
    expect(parseCreditLimit("You requested up to 65536 tokens.")).toBeNull();
    expect(parseCreditLimit("You can only afford 45822.")).toBeNull();
  });

  it("does not stitch the two halves out of unrelated sentences", () => {
    const body =
      "You requested up to 65536 tokens. " +
      "Separately, and for entirely unrelated billing reasons that have " +
      "nothing to do with the ceiling above, you can only afford 1.";
    expect(parseCreditLimit(body)).toBeNull();
  });

  it("returns null on unrelated 402 wording", () => {
    expect(
      parseCreditLimit("Payment required: your account balance is negative."),
    ).toBeNull();
  });

  it("returns null on a zero or non-numeric affordable count", () => {
    expect(
      parseCreditLimit("You requested up to 65536 tokens, but can only afford 0."),
    ).toBeNull();
    expect(
      parseCreditLimit("You requested up to 65536 tokens, but can only afford many."),
    ).toBeNull();
  });

  it("returns null on empty and non-string input", () => {
    expect(parseCreditLimit("")).toBeNull();
    expect(parseCreditLimit(undefined as unknown as string)).toBeNull();
  });
});
