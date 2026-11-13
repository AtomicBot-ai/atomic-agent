import { describe, it, expect } from "vitest";
import {
  formatDuration,
  formatSkillEvalDiff,
  formatTokens,
  shouldUseColor,
  skillEvalTotals,
  skillEvalVerdict,
  type SkillEvalDiffInput,
  type SkillEvalRunStats,
} from "./skill-eval-diff-formatter.js";

/**
 * `skill eval` difference table (ATO-1100). The table is what a skill
 * author reads to decide whether the skill is worth keeping, so the
 * pinned parts are: columns line up, deltas carry their sign and the
 * right base, a task missing one side never skews the total, and the
 * verdict follows the documented thresholds.
 */

function stats(
  passed: number,
  total: number,
  wallMs: number,
  tokensIn: number,
  tokensOut: number,
): SkillEvalRunStats {
  return { passed, total, wallMs, tokensIn, tokensOut };
}

const ANSI = /\u001b\[[0-9;]*m/g;

function sample(): SkillEvalDiffInput {
  return {
    skill: "pdf-tools",
    tasks: [
      {
        id: "extract",
        without: stats(0, 1, 4000, 1200, 300),
        with: stats(1, 1, 3000, 1500, 250),
      },
      {
        id: "merge-two-files",
        without: stats(1, 1, 3000, 800, 200),
        with: stats(1, 1, 2000, 900, 150),
      },
    ],
  };
}

describe("formatSkillEvalDiff", () => {
  it("renders the full table, totals and verdict", () => {
    expect(formatSkillEvalDiff(sample())).toBe(
      [
        "Skill eval: pdf-tools (2 tasks, without -> with)",
        "",
        "task               accuracy    delta          time  delta     tokens in  delta  tokens out  delta",
        "extract          0/1 -> 1/1  +100 pp  4.0s -> 3.0s   -25%  1.2k -> 1.5k   +25%  300 -> 250   -17%",
        "merge-two-files  1/1 -> 1/1     0 pp  3.0s -> 2.0s   -33%    800 -> 900   +13%  200 -> 150   -25%",
        "total            1/2 -> 2/2   +50 pp  7.0s -> 5.0s   -29%  2.0k -> 2.4k   +20%  500 -> 400   -20%",
        "",
        "Verdict: skill helped (accuracy +50 pp)",
      ].join("\n"),
    );
  });

  it("gives every table row the same width and starts columns at the same offset", () => {
    const lines = formatSkillEvalDiff(sample()).split("\n").slice(2, 6);
    const widths = new Set(lines.map((l) => l.length));
    expect(widths.size).toBe(1);
    // The task column is left-aligned: the accuracy cell starts right
    // after the widest task id plus the two-space gap on every row.
    const start = "merge-two-files".length + 2;
    for (const line of lines.slice(1)) {
      expect(line[start - 1]).toBe(" ");
      expect(line[start]).not.toBe(" ");
    }
  });

  it("does not end lines with spaces", () => {
    for (const line of formatSkillEvalDiff(sample()).split("\n")) {
      expect(line).toBe(line.trimEnd());
    }
  });

  it("prints no colour codes by default", () => {
    expect(formatSkillEvalDiff(sample())).not.toMatch(ANSI);
  });

  it("with colour, keeps the same layout once the codes are stripped", () => {
    const plain = formatSkillEvalDiff(sample());
    const coloured = formatSkillEvalDiff(sample(), { color: true });
    expect(coloured).toMatch(ANSI);
    expect(coloured.replace(ANSI, "")).toBe(plain);
  });

  it("colours good deltas green and bad ones red, by direction", () => {
    const out = formatSkillEvalDiff(sample(), { color: true });
    // Accuracy up is good; tokens in up is bad; time down is good.
    expect(out).toContain("\u001b[32m+100 pp\u001b[39m");
    expect(out).toContain("\u001b[31m+25%\u001b[39m");
    expect(out).toContain("\u001b[32m-25%\u001b[39m");
    // A zero delta stays uncoloured.
    expect(out).toContain(" 0 pp");
    expect(out).not.toContain("\u001b[32m0 pp");
    expect(out).toContain("\u001b[32mVerdict: skill helped");
  });

  it("shows a missing side as '-' and leaves that task out of the total", () => {
    const out = formatSkillEvalDiff({
      skill: "x",
      tasks: [
        { id: "a", without: null, with: stats(1, 1, 500, 10, 10) },
        {
          id: "b",
          without: stats(1, 1, 1000, 100, 100),
          with: stats(1, 1, 1100, 105, 95),
        },
      ],
    });
    const lines = out.split("\n");
    expect(lines[3]).toBe(
      "a        - -> 1/1    n/a    - -> 500ms    n/a     - -> 10    n/a     - -> 10    n/a",
    );
    // Total equals task b alone.
    expect(lines[5]).toBe(
      "total  1/1 -> 1/1   0 pp  1.0s -> 1.1s   +10%  100 -> 105    +5%   100 -> 95    -5%",
    );
    expect(out).toContain(
      "1 task did not run on both sides and is left out of the total.",
    );
  });

  it("uses the plural in the left-out note", () => {
    const out = formatSkillEvalDiff({
      skill: "x",
      tasks: [
        { id: "a", without: null, with: null },
        { id: "b", without: stats(1, 1, 1, 1, 1), with: null },
      ],
    });
    expect(out).toContain(
      "2 tasks did not run on both sides and are left out of the total.",
    );
    // No task ran on both sides: no total row at all.
    expect(out).not.toMatch(/^total/m);
    expect(out).toContain("Verdict: no data to compare");
  });

  it("handles an empty task set", () => {
    expect(formatSkillEvalDiff({ skill: "x", tasks: [] })).toBe(
      [
        "Skill eval: x (0 tasks, without -> with)",
        "",
        "No tasks.",
        "",
        "Verdict: no data to compare (no task ran both without and with the skill)",
      ].join("\n"),
    );
  });

  it("uses the singular for one task", () => {
    const out = formatSkillEvalDiff({
      skill: "x",
      tasks: [
        { id: "a", without: stats(1, 1, 1, 1, 1), with: stats(1, 1, 1, 1, 1) },
      ],
    });
    expect(out.split("\n")[0]).toBe("Skill eval: x (1 task, without -> with)");
  });

  it("prints n/a for a percentage against a zero baseline and 0% for zero to zero", () => {
    const out = formatSkillEvalDiff({
      skill: "x",
      tasks: [
        {
          id: "a",
          without: stats(1, 1, 0, 0, 0),
          with: stats(1, 1, 0, 50, 0),
        },
      ],
    });
    const row = out.split("\n")[3]!;
    // time 0 -> 0: 0%; tokens in 0 -> 50: n/a; tokens out 0 -> 0: 0%.
    expect(row).toBe(
      "a      1/1 -> 1/1   0 pp  0ms -> 0ms     0%    0 -> 50    n/a      0 -> 0     0%",
    );
  });

  it("prints n/a accuracy when a side ran zero attempts", () => {
    const out = formatSkillEvalDiff({
      skill: "x",
      tasks: [
        { id: "a", without: stats(0, 0, 0, 0, 0), with: stats(1, 1, 10, 1, 1) },
      ],
    });
    expect(out.split("\n")[3]).toMatch(/^a\s+0\/0 -> 1\/1\s+n\/a/);
    expect(out).toContain("Verdict: no data to compare");
  });
});

describe("skillEvalTotals", () => {
  it("sums only paired tasks and counts the rest", () => {
    const totals = skillEvalTotals({
      skill: "x",
      tasks: [
        { id: "a", without: stats(1, 2, 10, 1, 2), with: stats(2, 2, 5, 3, 4) },
        { id: "b", without: stats(1, 1, 7, 1, 1), with: null },
        { id: "c", without: stats(0, 3, 20, 5, 5), with: stats(3, 3, 30, 6, 6) },
      ],
    });
    expect(totals.paired).toBe(2);
    expect(totals.unpaired).toBe(1);
    expect(totals.without).toEqual(stats(1, 5, 30, 6, 7));
    expect(totals.with).toEqual(stats(5, 5, 35, 9, 10));
  });
});

describe("skillEvalVerdict", () => {
  function one(
    without: SkillEvalRunStats,
    withSkill: SkillEvalRunStats,
  ): ReturnType<typeof skillEvalVerdict> {
    return skillEvalVerdict({
      skill: "x",
      tasks: [{ id: "a", without, with: withSkill }],
    });
  }

  it("helped at exactly +10 accuracy points", () => {
    const v = one(stats(9, 10, 100, 10, 10), stats(10, 10, 100, 10, 10));
    expect(v.kind).toBe("helped");
    expect(v.line).toBe("Verdict: skill helped (accuracy +10 pp)");
  });

  it("hurt at exactly -10 accuracy points, even when it got cheaper", () => {
    const v = one(stats(10, 10, 100, 100, 100), stats(9, 10, 10, 10, 10));
    expect(v.kind).toBe("hurt");
    expect(v.line).toBe("Verdict: skill hurt (accuracy -10 pp)");
  });

  it("accuracy wins over cost: +50 pp at double the tokens is still helped", () => {
    const v = one(stats(1, 2, 100, 100, 100), stats(2, 2, 100, 200, 200));
    expect(v.kind).toBe("helped");
  });

  it("no clear difference just under the accuracy threshold with flat cost", () => {
    const v = one(stats(91, 100, 100, 100, 100), stats(100, 100, 110, 110, 90));
    expect(v.kind).toBe("no_clear_difference");
    expect(v.line).toBe(
      "Verdict: no clear difference (accuracy, time and tokens within 10 pp / 20%, or mixed)",
    );
  });

  it("helped on same accuracy when time drops by 20% and tokens stay", () => {
    const v = one(stats(1, 1, 1000, 100, 100), stats(1, 1, 800, 100, 100));
    expect(v.kind).toBe("helped");
    expect(v.line).toBe("Verdict: skill helped (same accuracy, time -20%)");
  });

  it("helped lists both time and tokens when both dropped", () => {
    const v = one(stats(1, 1, 1000, 100, 100), stats(1, 1, 500, 50, 50));
    expect(v.line).toBe(
      "Verdict: skill helped (same accuracy, time -50%, tokens -50%)",
    );
  });

  it("hurt on same accuracy when tokens (in + out) rise by 20% or more", () => {
    const v = one(stats(1, 1, 1000, 100, 100), stats(1, 1, 1000, 140, 100));
    expect(v.kind).toBe("hurt");
    expect(v.line).toBe("Verdict: skill hurt (same accuracy, tokens +20%)");
  });

  it("mixed cost (faster but more tokens) is no clear difference", () => {
    const v = one(stats(1, 1, 1000, 100, 100), stats(1, 1, 500, 200, 200));
    expect(v.kind).toBe("no_clear_difference");
  });

  it("just under the cost threshold is no clear difference", () => {
    const v = one(stats(1, 1, 1000, 100, 100), stats(1, 1, 810, 100, 100));
    expect(v.kind).toBe("no_clear_difference");
  });

  it("a zero cost baseline is ignored rather than read as infinite", () => {
    // Tokens 0 -> 100 has no percentage; time dropped 50%, so helped.
    const v = one(stats(1, 1, 1000, 0, 0), stats(1, 1, 500, 50, 50));
    expect(v.line).toBe("Verdict: skill helped (same accuracy, time -50%)");
  });

  it("uses pooled pass rates, not the mean of per-task rates", () => {
    // Pooled: 1/11 -> 2/11 = +9 pp (no clear). Mean of rates would be
    // (0 -> 1/1 = +100, 1/10 -> 1/10 = 0) / 2 = +50.
    const v = skillEvalVerdict({
      skill: "x",
      tasks: [
        { id: "a", without: stats(0, 1, 1, 1, 1), with: stats(1, 1, 1, 1, 1) },
        {
          id: "b",
          without: stats(1, 10, 1, 1, 1),
          with: stats(1, 10, 1, 1, 1),
        },
      ],
    });
    expect(v.kind).toBe("no_clear_difference");
  });

  it("no data when nothing is paired", () => {
    expect(skillEvalVerdict({ skill: "x", tasks: [] }).kind).toBe("no_data");
    expect(
      skillEvalVerdict({
        skill: "x",
        tasks: [{ id: "a", without: stats(1, 1, 1, 1, 1), with: null }],
      }).kind,
    ).toBe("no_data");
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "0ms"],
    [-5, "0ms"],
    [850, "850ms"],
    [999, "999ms"],
    [1000, "1.0s"],
    [4230, "4.2s"],
    [59_940, "59.9s"],
    [59_960, "1m 00s"],
    [125_000, "2m 05s"],
    [3_600_000, "60m 00s"],
  ])("%d ms -> %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe("formatTokens", () => {
  it.each([
    [0, "0"],
    [-3, "0"],
    [850, "850"],
    [999, "999"],
    [1000, "1.0k"],
    [12_345, "12.3k"],
    [1_200_000, "1.2M"],
  ])("%d -> %s", (count, text) => {
    expect(formatTokens(count)).toBe(text);
  });
});

describe("shouldUseColor", () => {
  it("NO_COLOR turns colour off even on a TTY or with FORCE_COLOR", () => {
    expect(shouldUseColor({ NO_COLOR: "1" }, true)).toBe(false);
    expect(shouldUseColor({ NO_COLOR: "1", FORCE_COLOR: "1" }, true)).toBe(
      false,
    );
  });

  it("an empty NO_COLOR does not count", () => {
    expect(shouldUseColor({ NO_COLOR: "" }, true)).toBe(true);
  });

  it("FORCE_COLOR turns colour on in a pipe; FORCE_COLOR=0 turns it off", () => {
    expect(shouldUseColor({ FORCE_COLOR: "1" }, false)).toBe(true);
    expect(shouldUseColor({ FORCE_COLOR: "0" }, true)).toBe(false);
    expect(shouldUseColor({ FORCE_COLOR: "0" }, false)).toBe(false);
  });

  it("otherwise follows the TTY", () => {
    expect(shouldUseColor({}, true)).toBe(true);
    expect(shouldUseColor({}, false)).toBe(false);
  });
});
