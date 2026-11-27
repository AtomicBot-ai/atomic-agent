import { describe, expect, it } from "vitest";

import {
  COUNCIL_MAX_ANSWER_CHARS,
  buildCouncilPrompt,
  councilLabel,
  councilMembers,
  formatCouncilSummary,
  parseCouncilSummary,
} from "./model-council.js";

const MEMBERS = councilMembers([
  { model: "or:gpt", text: "Use Postgres.", ms: 1 },
  { model: "down", error: "401", ms: 1 },
  { model: "empty", text: "   ", ms: 1 },
  { model: "ollama:qwen3:8b", text: "Use SQLite.", ms: 1 },
]);

describe("councilMembers / councilLabel (ATO-2232)", () => {
  it("letters only the answers worth judging, in the named order", () => {
    expect(MEMBERS).toEqual([
      { label: "A", model: "or:gpt", text: "Use Postgres." },
      { label: "B", model: "ollama:qwen3:8b", text: "Use SQLite." },
    ]);
    expect(councilLabel(25)).toBe("Z");
    expect(councilLabel(26)).toBe("M27");
  });
});

describe("buildCouncilPrompt", () => {
  it("hides model names, lists each answer by letter and asks for the three sections", () => {
    const prompt = buildCouncilPrompt("Which database?", MEMBERS);
    expect(prompt).not.toContain("or:gpt");
    expect(prompt).not.toContain("qwen3");
    expect(prompt).toContain("## Question\nWhich database?");
    expect(prompt).toContain("### Answer A\nUse Postgres.");
    expect(prompt).toContain("### Answer B\nUse SQLite.");
    expect(prompt).toMatch(/## Agree[\s\S]*## Disagree[\s\S]*## Unique/);
  });

  it("cuts an overlong answer", () => {
    const long = "x".repeat(COUNCIL_MAX_ANSWER_CHARS + 50);
    const prompt = buildCouncilPrompt("q", [{ label: "A", model: "m", text: long }]);
    expect(prompt).toContain(`[answer cut at ${COUNCIL_MAX_ANSWER_CHARS} characters]`);
    expect(prompt).not.toContain("x".repeat(COUNCIL_MAX_ANSWER_CHARS + 1));
  });
});

describe("parseCouncilSummary", () => {
  it("reads the format the prompt asks for and maps letters back to model names", () => {
    const reply = [
      "## Agree",
      "- Both pick a SQL database",
      "## Disagree",
      "- A says Postgres, B says SQLite",
      "## Unique",
      "### Answer A",
      "- Mentions replication",
      "### Answer B",
      "- none",
    ].join("\n");
    const summary = parseCouncilSummary(reply, MEMBERS);
    expect(summary).toMatchObject({
      parsed: true,
      agree: ["Both pick a SQL database"],
      disagree: ["A says Postgres, B says SQLite"],
      unique: { "or:gpt": ["Mentions replication"], "ollama:qwen3:8b": [] },
    });
  });

  it("accepts bold or colon headings, numbered bullets and `B: point` lines", () => {
    const reply = [
      "**Agreement**",
      "1. Both are SQL",
      "Disagree:",
      "* Engine choice",
      "Unique:",
      "- B: runs without a server",
      "- ollama:qwen3:8b: one file on disk",
      "- A: none",
    ].join("\n");
    const summary = parseCouncilSummary(reply, MEMBERS);
    expect(summary.agree).toEqual(["Both are SQL"]);
    expect(summary.disagree).toEqual(["Engine choice"]);
    expect(summary.unique).toEqual({ "or:gpt": [], "ollama:qwen3:8b": ["runs without a server", "one file on disk"] });
  });

  it("does not read a point starting with a single letter word as that answer", () => {
    const reply = ["## Unique", "### Answer B", "- A key idea: no server needed"].join("\n");
    expect(parseCouncilSummary(reply, MEMBERS).unique).toEqual({
      "or:gpt": [],
      "ollama:qwen3:8b": ["A key idea: no server needed"],
    });
  });

  it("keeps a reply without headings as raw text", () => {
    const summary = parseCouncilSummary("They mostly agree.", MEMBERS);
    expect(summary.parsed).toBe(false);
    expect(formatCouncilSummary(summary, "or:gpt")).toBe("== Council summary (judge: or:gpt) ==\nThey mostly agree.\n");
  });
});

describe("formatCouncilSummary", () => {
  it("prints the sections under model names, with (nothing) for an empty list", () => {
    const text = formatCouncilSummary(
      { parsed: true, raw: "", agree: ["SQL"], disagree: [], unique: { "or:gpt": ["replication"], b: [] } },
      "or:gpt",
    );
    expect(text).toBe(
      [
        "== Council summary (judge: or:gpt) ==",
        "Agree",
        "  - SQL",
        "Disagree",
        "  (nothing)",
        "Unique",
        "  or:gpt",
        "    - replication",
        "  b",
        "    (nothing)",
        "",
      ].join("\n"),
    );
  });
});
