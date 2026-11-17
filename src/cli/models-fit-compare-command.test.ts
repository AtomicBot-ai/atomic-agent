import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIT_TEST_RUN_KIND, FIT_TEST_RUN_VERSION, type FitTestRun } from "../fit-test/index.js";
import { parseFitCompareArgs, runModelsFitCompare } from "./models-fit-compare-command.js";

function run(modelId: string, score: number): FitTestRun {
  return {
    kind: FIT_TEST_RUN_KIND,
    version: FIT_TEST_RUN_VERSION,
    createdAt: "x",
    taskSetCreatedAt: "s",
    taskIds: ["a"],
    gpuBudgetGb: null,
    models: [{ modelId, loadError: null, loadMs: 0, peakMemoryBytes: null, tasks: [{ taskId: "a", score, reason: "", durationMs: 1000, tokens: 10, timedOut: false }] }],
  };
}

describe("models fit-test --compare", () => {
  let dir: string;
  let out: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-fit-compare-"));
    out = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("needs two files after --compare", () => {
    expect(parseFitCompareArgs(["--compare", "a.json"])).toMatchObject({ error: expect.stringMatching(/two run files/) });
    expect(parseFitCompareArgs(["--compare", "a.json", "--json"])).toMatchObject({ error: expect.stringMatching(/two run files/) });
    expect(runModelsFitCompare(["--compare"])).toBe(2);
  });

  it("prints the report for two run files", () => {
    const a = join(dir, "a.json");
    const b = join(dir, "b.json");
    writeFileSync(a, JSON.stringify(run("base", 3)));
    writeFileSync(b, JSON.stringify(run("base+lora", 5)));
    expect(runModelsFitCompare(["--compare", a, b])).toBe(0);
    const text = out.join("");
    expect(text).toContain("before: base   after: base+lora");
    expect(text).toMatch(/a\s+3 -> 5\s+\+2/);
  });
});
