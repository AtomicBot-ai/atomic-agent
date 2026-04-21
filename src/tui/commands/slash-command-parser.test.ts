import { describe, expect, it } from "vitest";
import { parseSlashCommand, slashPrefix } from "./slash-command-parser.js";

describe("parseSlashCommand", () => {
  it("returns null for non-slash input", () => {
    expect(parseSlashCommand("hello")).toBeNull();
    expect(parseSlashCommand("  ")).toBeNull();
    expect(parseSlashCommand("/")).toBeNull();
  });

  it("parses a bare command", () => {
    expect(parseSlashCommand("/clear")).toEqual({ name: "clear", args: "" });
    expect(parseSlashCommand("  /HELP  ")).toEqual({ name: "help", args: "" });
  });

  it("parses a command with arguments", () => {
    expect(parseSlashCommand("/session new")).toEqual({
      name: "session",
      args: "new",
    });
    expect(parseSlashCommand("/model llama3.2 7b")).toEqual({
      name: "model",
      args: "llama3.2 7b",
    });
  });
});

describe("slashPrefix", () => {
  it("returns the characters after the slash", () => {
    expect(slashPrefix("/")).toBe("");
    expect(slashPrefix("/cle")).toBe("cle");
  });

  it("returns null once the user types whitespace", () => {
    expect(slashPrefix("/session new")).toBeNull();
    expect(slashPrefix("hello /foo")).toBeNull();
  });
});
