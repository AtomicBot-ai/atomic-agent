import { describe, expect, it } from "vitest";

import {
  SHORT_MESSAGE_WORD_THRESHOLD,
  isReferentialMessage,
} from "./referential-detector.js";

describe("isReferentialMessage", () => {
  // -------------------- false-negatives (gate must NOT fire) --------------------

  it("returns false when there is no history (first turn)", () => {
    expect(isReferentialMessage("what?", 0)).toBe(false);
    expect(isReferentialMessage("it broke", 0)).toBe(false);
  });

  it("returns false for an empty message", () => {
    expect(isReferentialMessage("", 4)).toBe(false);
    expect(isReferentialMessage("   ", 4)).toBe(false);
  });

  it("returns false for a long self-contained question without referential markers", () => {
    const msg =
      "please walk me through how the BM25 ranking algorithm scores documents end to end";
    expect(isReferentialMessage(msg, 4)).toBe(false);
  });

  it("returns false for a short message that contains a question word", () => {
    // "what is FTS5?" — short but self-contained because of "what".
    expect(isReferentialMessage("what is FTS5?", 4)).toBe(false);
  });

  // -------------------- true-positives (gate fires) --------------------

  it("fires on short messages with no question word", () => {
    // "ok continue" — 2 words, no question word, history present.
    expect(isReferentialMessage("ok continue", 4)).toBe(true);
  });

  it("fires on English pronouns inside longer messages", () => {
    expect(
      isReferentialMessage("how does it interact with FTS5 ranking?", 4),
    ).toBe(true);
  });

  it("fires on Russian pronouns inside longer messages", () => {
    expect(
      isReferentialMessage("расскажи подробнее про это", 2),
    ).toBe(true);
  });

  it("fires on conjunction starters (English)", () => {
    expect(isReferentialMessage("And what about caching?", 4)).toBe(true);
    expect(isReferentialMessage("but why does that happen", 4)).toBe(true);
  });

  it("fires on conjunction starters (Russian)", () => {
    expect(isReferentialMessage("А что насчёт кэша?", 4)).toBe(true);
    expect(isReferentialMessage("Но почему так происходит", 4)).toBe(true);
  });

  it("strips punctuation before classifying", () => {
    // Pronoun with trailing comma should still match.
    expect(isReferentialMessage("they, hmm, broke the test", 2)).toBe(true);
  });

  // -------------------- threshold sanity --------------------

  it("pins the short-message word threshold for tests", () => {
    expect(SHORT_MESSAGE_WORD_THRESHOLD).toBe(5);
  });
});
