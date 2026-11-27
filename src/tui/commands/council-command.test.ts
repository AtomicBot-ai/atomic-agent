import { describe, expect, it } from "vitest";

import { COUNCIL_USAGE, parseCouncilCommand } from "./council-command.js";
import { dispatchSlashCommand } from "./slash-command-handler.js";
import { SLASH_COMMANDS } from "./slash-commands.js";

describe("parseCouncilCommand (ATO-2432)", () => {
  it("reads the flags anywhere and keeps the rest as the question", () => {
    expect(
      parseCouncilCommand("--models or:a,local*2 Postgres or SQLite --no-rank --judge or:j --max-usd $0.5 for a desktop app?"),
    ).toEqual({
      kind: "run",
      request: {
        question: "Postgres or SQLite for a desktop app?",
        models: "or:a,local*2",
        judge: "or:j",
        rank: false,
        maxUsd: 0.5,
      },
    });
    expect(parseCouncilCommand("--no-chairman --dry-run q")).toEqual({
      kind: "run",
      request: { question: "q", chairman: null, dryRun: true },
    });
  });

  it("stops, and prints usage for no question or a flag without a value", () => {
    expect(parseCouncilCommand("stop")).toEqual({ kind: "stop" });
    expect(parseCouncilCommand("  ")).toEqual({ kind: "usage", message: COUNCIL_USAGE });
    expect(parseCouncilCommand("--no-rank")).toEqual({ kind: "usage", message: COUNCIL_USAGE });
    expect(parseCouncilCommand("q --models")).toMatchObject({ kind: "usage" });
    expect(parseCouncilCommand("q --max-usd lots")).toMatchObject({ kind: "usage" });
  });

  it("is a slash command the palette lists and the handler hands to the caller", () => {
    expect(SLASH_COMMANDS.some((c) => c.name === "council")).toBe(true);
    const result = dispatchSlashCommand("/council which db?");
    expect(result.councilCommand).toEqual({ kind: "run", request: { question: "which db?" } });
  });
});
