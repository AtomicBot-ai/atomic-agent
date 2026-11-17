import { describe, expect, it } from "vitest";

import { surfaceShowsQuestions, withAskUserVisibility } from "./ask-user-surface.js";

describe("ask_user surfaces (ATO-489)", () => {
  it("offers the tool to the TUI, the CLI and Telegram", () => {
    expect(surfaceShowsQuestions({ origin: "tui", answerChannel: "terminal" })).toBe(true);
    expect(surfaceShowsQuestions({ origin: "cli" })).toBe(true);
    expect(surfaceShowsQuestions({})).toBe(true);
    expect(surfaceShowsQuestions({ origin: "telegram", answerChannel: "telegram" })).toBe(true);
  });

  it("hides it from the desktop until ATO-1502, sidecar and HTTP extensions alike", () => {
    expect(surfaceShowsQuestions({ origin: "sidecar", answerChannel: "desktop" })).toBe(false);
    expect(surfaceShowsQuestions({ origin: "http", answerChannel: "desktop" })).toBe(false);
  });

  it("hides it where nobody can answer", () => {
    for (const origin of ["http", "discord", "scheduler", "fusion"]) {
      expect(surfaceShowsQuestions({ origin })).toBe(false);
    }
  });

  it("follows a client that declares the question card", () => {
    expect(surfaceShowsQuestions({ origin: "http", answerChannel: "desktop", questions: true })).toBe(true);
    expect(surfaceShowsQuestions({ origin: "tui", questions: false })).toBe(false);
  });

  it("returns the caller's filter untouched where questions show", () => {
    const filter = (name: string) => name !== "fs.write";
    expect(withAskUserVisibility(filter, true)).toBe(filter);
    expect(withAskUserVisibility(undefined, true)).toBeUndefined();
  });

  it("drops only ask_user, on top of the caller's filter, where they do not", () => {
    const alone = withAskUserVisibility(undefined, false)!;
    expect(alone("ask_user")).toBe(false);
    expect(alone("fs.read")).toBe(true);
    const composed = withAskUserVisibility((name) => name !== "fs.write", false)!;
    expect(composed("ask_user")).toBe(false);
    expect(composed("fs.write")).toBe(false);
    expect(composed("fs.read")).toBe(true);
  });
});
