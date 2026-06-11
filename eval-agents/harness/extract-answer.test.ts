import { describe, expect, it } from "vitest";

import { extractFinalAnswer } from "./extract-answer.js";

describe("extractFinalAnswer", () => {
  it("reads FINAL ANSWER marker", () => {
    const reply = "Worked through the file.\nFINAL ANSWER: Oslo";
    expect(extractFinalAnswer(reply)).toBe("Oslo");
  });

  it("falls back to last line", () => {
    expect(extractFinalAnswer("step 1\nstep 2\n42")).toBe("42");
  });

  it("picks the LAST FINAL ANSWER when restated", () => {
    const reply = "FINAL ANSWER: maybe Paris\nWait, reconsidering.\nFINAL ANSWER: Oslo";
    expect(extractFinalAnswer(reply)).toBe("Oslo");
  });

  it("reads the answer from the next line when marker is alone", () => {
    expect(extractFinalAnswer("Reasoning...\nFINAL ANSWER:\nOslo")).toBe("Oslo");
  });

  it("strips wrapping quotes", () => {
    expect(extractFinalAnswer('FINAL ANSWER: "red, blue"')).toBe("red, blue");
  });

  it("returns empty string for blank reply", () => {
    expect(extractFinalAnswer("   \n  ")).toBe("");
  });
});
