import { describe, expect, it } from "vitest";

import { buildReport, type ImportItemResult } from "../import/import-report.js";
import { finaleLines, finaleSentence, finaleRows, writeImportFinale } from "./import-finale.js";

function items(kind: string, status: ImportItemResult["status"], n: number): ImportItemResult[] {
  return Array.from({ length: n }, (_, i) => ({ kind, status, source: `${kind}-${i}` }));
}

const report = buildReport(
  [...items("sessions", "migrated", 44), ...items("memory", "migrated", 6), ...items("skills", "migrated", 9), ...items("skills", "skipped", 1)],
  true,
);

describe("import finale (ATO-818)", () => {
  it("counts each kind in the order it first appears", () => {
    expect(finaleRows(report).map((r) => [r.kind, r.imported, r.skipped])).toEqual([
      ["sessions", 44, 0],
      ["memory", 6, 0],
      ["skills", 9, 1],
    ]);
  });

  it("prints a checked row per kind, then the sentence", () => {
    expect(finaleLines(report)).toEqual([
      "  ✓ sessions  44 imported",
      "  ✓ memory     6 imported",
      "  ✓ skills     9 imported, 1 skipped",
      "",
      "  44 chats and 6 memories are now in Atomic Agent.",
    ]);
  });

  it("marks a kind with failures and says nothing for a preview", () => {
    const bad = buildReport([...items("cron", "migrated", 2), ...items("cron", "error", 1)], true);
    expect(finaleLines(bad)[0]).toBe("  ! cron  2 imported, 1 failed");
    expect(finaleSentence(finaleRows(bad))).toBe("2 items are now in Atomic Agent.");
    expect(finaleLines(buildReport(items("sessions", "migrated", 3), false))).toEqual([]);
  });

  it("uses the singular for one", () => {
    expect(finaleSentence(finaleRows(buildReport(items("sessions", "migrated", 1), true)))).toBe(
      "1 chat is now in Atomic Agent.",
    );
  });

  it("writes everything at once when stdout is not a terminal", async () => {
    const out: string[] = [];
    let slept = 0;
    await writeImportFinale(report, { write: (t) => out.push(t), isTTY: false, sleep: async () => { slept += 1; } });
    expect(slept).toBe(0);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("44 chats and 6 memories are now in Atomic Agent.");
  });

  it("brings the rows in one by one on a terminal", async () => {
    const out: string[] = [];
    let slept = 0;
    await writeImportFinale(report, { write: (t) => out.push(t), isTTY: true, sleep: async () => { slept += 1; } });
    expect(slept).toBe(4); // three rows and the sentence; the blank line does not wait
    expect(out.join("")).toBe(`\n${finaleLines(report).join("\n")}\n`);
  });

  it("prints nothing under --json", async () => {
    const out: string[] = [];
    await writeImportFinale(report, { write: (t) => out.push(t), isTTY: true, json: true });
    expect(out).toEqual([]);
  });
});
