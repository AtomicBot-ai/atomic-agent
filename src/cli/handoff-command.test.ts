import { describe, expect, it } from "vitest";

import { parseHandoffArgs } from "./handoff-command.js";

describe("parseHandoffArgs", () => {
  it("requires --from and accepts only the two agents", () => {
    expect(parseHandoffArgs([])).toEqual({
      error: "--from is required (claude-code or codex)",
    });
    expect(parseHandoffArgs(["--from", "hermes"])).toEqual({
      error: "--from must be claude-code or codex, not hermes",
    });
  });

  it("defaults to the latest session, opening it", () => {
    expect(parseHandoffArgs(["--from", "claude-code"])).toMatchObject({
      agent: "claude-code",
      session: "latest",
      list: false,
      json: false,
      open: true,
      limit: 10,
    });
  });

  it("reads every option", () => {
    const parsed = parseHandoffArgs([
      "--from",
      "codex",
      "--session",
      "0199a1",
      "--note",
      "run the tests first",
      "--list",
      "--limit",
      "5",
      "--json",
      "--no-open",
    ]);
    expect(parsed).toMatchObject({
      agent: "codex",
      session: "0199a1",
      note: "run the tests first",
      list: true,
      limit: 5,
      json: true,
      open: false,
    });
  });

  it("refuses a flag without its value and unknown flags", () => {
    expect(parseHandoffArgs(["--from", "codex", "--session"])).toHaveProperty("error");
    expect(parseHandoffArgs(["--from", "codex", "--limit", "0"])).toHaveProperty("error");
    expect(parseHandoffArgs(["--from", "codex", "--bogus"])).toEqual({
      error: "unknown flag: --bogus",
    });
  });

  it("returns help", () => {
    expect(parseHandoffArgs(["--help"])).toEqual({ help: true });
  });
});
