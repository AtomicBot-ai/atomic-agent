import { describe, expect, it } from "vitest";
import { activeMention, completeMention } from "./mention-query.js";

describe("activeMention", () => {
  it("finds the @ token at the end of the buffer", () => {
    expect(activeMention("look at @src/ap")).toEqual({ start: 8, query: "src/ap" });
    expect(activeMention("@")).toEqual({ start: 0, query: "" });
  });

  it("ignores an @ inside a word, like an email address", () => {
    expect(activeMention("mail me@example.com")).toBeNull();
  });

  it("closes once the token is followed by a space", () => {
    expect(activeMention("look at @src/app.ts ")).toBeNull();
    expect(activeMention("plain text")).toBeNull();
  });

  it("follows the token on a later line of a multi-line buffer", () => {
    expect(activeMention("first line\n@READ")).toEqual({ start: 11, query: "READ" });
  });
});

describe("completeMention", () => {
  it("replaces the typed token with the chosen path and a space", () => {
    const buffer = "check @ap";
    const mention = activeMention(buffer);
    expect(mention).not.toBeNull();
    expect(completeMention(buffer, mention!, "src/app.ts")).toBe("check @src/app.ts ");
  });
});
