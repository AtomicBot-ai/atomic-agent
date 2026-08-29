import { describe, expect, it } from "vitest";

import {
  filterWizardRows,
  matchesSearchTerms,
  searchTerms,
  type WizardFilterRow,
} from "./providers-wizard-filter.js";
import { clampCursor, visibleKindRows } from "./providers-wizard-phases.js";

const ROWS: readonly WizardFilterRow[] = [
  { id: "anthropic/claude-opus-5", label: "anthropic/claude-opus-5 · 200k · $$" },
  { id: "claude-cli", label: "Claude Code subscription (drives your `claude` CLI)" },
  { id: "gemini", label: "Gemini (Google AI)" },
  { id: "qwen/qwen3-coder", label: "qwen/qwen3-coder · 256k · tools" },
];

function ids(rows: readonly WizardFilterRow[]): readonly string[] {
  return rows.map((row) => row.id);
}

describe("matchesSearchTerms", () => {
  const cases: readonly {
    name: string;
    query: string;
    expected: readonly string[];
  }[] = [
    { name: "no query keeps every row", query: "", expected: ids(ROWS) },
    {
      name: "substring of an id",
      query: "opus",
      expected: ["anthropic/claude-opus-5"],
    },
    {
      name: "substring is case-insensitive",
      query: "OPUS",
      expected: ["anthropic/claude-opus-5"],
    },
    {
      name: "a row is matched by its id even when the label omits the term",
      query: "qwen3",
      expected: ["qwen/qwen3-coder"],
    },
    {
      name: "a row is matched by its label alone",
      query: "google",
      expected: ["gemini"],
    },
    {
      name: "a term shared by two rows keeps both",
      query: "claude",
      expected: ["anthropic/claude-opus-5", "claude-cli"],
    },
    {
      name: "two terms narrow rather than widen",
      query: "claude code",
      expected: ["claude-cli"],
    },
    {
      name: "terms may match one in the id and one in the label",
      query: "gemini ai",
      expected: ["gemini"],
    },
    { name: "no matches leaves an empty list", query: "zzzz", expected: [] },
    {
      name: "surrounding whitespace is not a term",
      query: "  opus  ",
      expected: ["anthropic/claude-opus-5"],
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const terms = searchTerms(testCase.query);
      const kept = ROWS.filter((row) => matchesSearchTerms(row, terms));
      expect(ids(kept)).toEqual(testCase.expected);
    });
  }
});

describe("filterWizardRows", () => {
  it("returns the input array itself for a closed box", () => {
    // Identity, not a copy: the catalog rows carry lazy label getters and
    // a fresh array per keystroke would force all 340 of them.
    expect(filterWizardRows(ROWS, null)).toBe(ROWS);
  });

  it("returns the input array itself for an empty query", () => {
    expect(filterWizardRows(ROWS, "")).toBe(ROWS);
  });

  it("keeps list order rather than ranking matches", () => {
    expect(ids(filterWizardRows(ROWS, "c"))).toEqual([
      "anthropic/claude-opus-5",
      "claude-cli",
      "qwen/qwen3-coder",
    ]);
  });

  it("reads a row's label only when its id cannot answer the term", () => {
    let labelReads = 0;
    const rows: readonly WizardFilterRow[] = [
      {
        id: "openrouter",
        get label(): string {
          labelReads += 1;
          return "OpenRouter (cloud chat)";
        },
      },
    ];
    filterWizardRows(rows, "openrouter");
    expect(labelReads).toBe(0);
    filterWizardRows(rows, "cloud");
    expect(labelReads).toBe(1);
  });
});

describe("cursor clamping against a filtered list", () => {
  const cases: readonly { query: string; cursor: number; expected: number }[] = [
    { query: "", cursor: 3, expected: 3 },
    // The list shrank under a cursor that was deep in it: the last row of
    // the filtered list is what the render highlights, so it is what
    // Enter has to select.
    { query: "cli", cursor: 20, expected: 1 },
    { query: "gemini", cursor: 20, expected: 0 },
    { query: "no-such-provider", cursor: 20, expected: 0 },
    { query: "cli", cursor: -4, expected: 0 },
  ];

  for (const testCase of cases) {
    it(`clamps cursor ${testCase.cursor} for "${testCase.query}"`, () => {
      const rows = visibleKindRows(testCase.query);
      expect(clampCursor(testCase.cursor, rows.length)).toBe(testCase.expected);
    });
  }

  it("finds the two subscription CLI rows by their shared word", () => {
    expect(ids(visibleKindRows("cli"))).toEqual(["claude-cli", "codex-cli"]);
  });

  it("finds a preset row by its own id rather than by its config kind", () => {
    expect(ids(visibleKindRows("groq"))).toEqual(["groq"]);
  });
});
