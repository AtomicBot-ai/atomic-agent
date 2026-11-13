import { describe, expect, it } from "vitest";

import {
  describeUserQuestionAnswer,
  parseTypedUserQuestionAnswer,
  renderUserQuestionText,
  validateUserQuestionAnswer,
  type UserQuestion,
} from "./user-question.js";

const single: UserQuestion = {
  prompt: "Which database?",
  options: [
    { label: "SQLite", description: "one file" },
    { label: "Postgres" },
    { label: "MySQL" },
  ],
  multiSelect: false,
  allowOther: true,
};
const multi: UserQuestion = { ...single, multiSelect: true, allowOther: false };

describe("validateUserQuestionAnswer (ATO-489)", () => {
  it("takes labels or 0-based indexes and returns labels in the question's order", () => {
    expect(validateUserQuestionAnswer(multi, { selected: ["MySQL", 0] })).toEqual({
      selected: ["SQLite", "MySQL"],
    });
  });

  it("refuses an option the question never offered", () => {
    expect(validateUserQuestionAnswer(single, { selected: ["Oracle"] })).toMatch(/not an option/);
    expect(validateUserQuestionAnswer(single, { selected: [7] })).toMatch(/not an option/);
  });

  it("refuses two picks on a single-choice question", () => {
    expect(validateUserQuestionAnswer(single, { selected: [0, 1] })).toBe(
      "this question takes one option",
    );
  });

  it("takes the person's own words only where the question allows them", () => {
    expect(validateUserQuestionAnswer(single, { other: "  DuckDB  " })).toEqual({
      selected: [],
      other: "DuckDB",
    });
    expect(validateUserQuestionAnswer(multi, { other: "DuckDB" })).toMatch(/no answer of your own/);
  });

  it("refuses an empty answer", () => {
    expect(validateUserQuestionAnswer(single, {})).toBe("pick an option or type an answer");
    expect(validateUserQuestionAnswer(single, { other: "   " })).toBe(
      "pick an option or type an answer",
    );
  });
});

describe("parseTypedUserQuestionAnswer", () => {
  it("reads numbers as picks, starting at 1", () => {
    expect(parseTypedUserQuestionAnswer(single, "2")).toEqual({ selected: ["Postgres"] });
    expect(parseTypedUserQuestionAnswer(multi, "1, 3")).toEqual({ selected: ["SQLite", "MySQL"] });
    expect(parseTypedUserQuestionAnswer(multi, "3 1")).toEqual({ selected: ["SQLite", "MySQL"] });
  });

  it("says which numbers exist when one is out of range", () => {
    expect(parseTypedUserQuestionAnswer(single, "4")).toBe("pick a number from 1 to 3");
    expect(parseTypedUserQuestionAnswer(single, "0")).toBe("pick a number from 1 to 3");
  });

  it("reads anything else as the person's own answer", () => {
    expect(parseTypedUserQuestionAnswer(single, "whatever is fastest")).toEqual({
      selected: [],
      other: "whatever is fastest",
    });
  });
});

describe("rendering", () => {
  it("numbers the options and says how to answer", () => {
    expect(renderUserQuestionText(single)).toBe(
      "1. SQLite - one file\n2. Postgres\n3. MySQL\nPick one, or answer in your own words.",
    );
    expect(renderUserQuestionText(multi).endsWith("Pick one or more.")).toBe(true);
  });

  it("describes an answer for the model", () => {
    expect(describeUserQuestionAnswer({ selected: ["SQLite"], other: "and a backup" })).toBe(
      'Picked: SQLite. Own answer: "and a backup".',
    );
  });
});
