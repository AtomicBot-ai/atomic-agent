import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DelegateTask } from "./delegate-args.js";
import {
  FusionOutcomeLog,
  cleanModelLabel,
  outcomeRowFor,
  outcomeSize,
  parseOutcomeRow,
  type FusionOutcomeRow,
} from "./outcome-log.js";
import { WorkerRunCollector, type WorkerTaskResult } from "./worker-result.js";

function result(over: Partial<WorkerTaskResult> = {}): WorkerTaskResult {
  return {
    ...new WorkerRunCollector().finish({
      id: "t1",
      title: "Refactor the secret billing module",
      reason: "reply",
      stepCount: 4,
      durationMs: 90_000,
    }),
    reply: "PRIVATE REPLY TEXT",
    ...over,
  };
}

function row(over: Partial<FusionOutcomeRow> = {}): FusionOutcomeRow {
  return {
    v: 1,
    at: 1,
    leg: "local",
    model: "qwen3-27b",
    size: "large",
    briefChars: 7_000,
    files: 1,
    status: "failed",
    durationMs: 60_000,
    steps: 3,
    writes: 0,
    costUsd: null,
    ...over,
  };
}

describe("fusion outcome log (ATO-949)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fusion-outcomes-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("sizes a task by its brief length and declared files", () => {
    expect(outcomeSize(200, 0)).toBe("small");
    expect(outcomeSize(1_499, 1)).toBe("small");
    expect(outcomeSize(1_500, 1)).toBe("medium");
    expect(outcomeSize(200, 2)).toBe("medium");
    expect(outcomeSize(6_000, 0)).toBe("large");
    expect(outcomeSize(100, 5)).toBe("large");
  });

  it("records counts and labels, never the brief, title, id, paths or reply", () => {
    const task: DelegateTask = {
      id: "t1",
      title: "Refactor the secret billing module",
      instructions: "SECRET INSTRUCTIONS ".repeat(10),
      deliverable: "a diff",
      files: ["/home/someone/private/billing.ts"],
    };
    const r = outcomeRowFor({
      result: result({
        status: "ok",
        error: "ENOENT /home/someone/private",
        usage: { promptTokens: 10, completionTokens: 42, totalTokens: 52 },
      }),
      task,
      leg: "cloud",
      model: "sonnet",
      costUsd: 0.03,
      at: 123,
    });
    expect(r).toMatchObject({
      leg: "cloud",
      model: "sonnet",
      size: "small",
      briefChars: task.instructions.length + 6,
      files: 1,
      status: "ok",
      durationMs: 90_000,
      steps: 4,
      outputTokens: 42,
      costUsd: 0.03,
      at: 123,
    });
    const text = JSON.stringify(r);
    for (const secret of ["SECRET", "billing", "/home", "PRIVATE", "t1", "ENOENT"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("names the role model when the task ran on one, and cleans the label", () => {
    const r = outcomeRowFor({
      result: result({ model: "coder`\nx", modelRole: "build" }),
      task: undefined,
      leg: "local",
      model: "qwen",
      costUsd: null,
      at: 1,
    });
    expect(r.model).toBe("coder x");
    expect(r.role).toBe("build");
    expect(r.size).toBe("small");
    expect(cleanModelLabel("m".repeat(200))).toHaveLength(80);
  });

  it("appends JSONL rows and reads them back, skipping junk lines", () => {
    const path = join(dir, "nested", "fusion-outcomes.jsonl");
    const log = new FusionOutcomeLog({ path });
    log.append(row({ at: 1 }));
    log.append(row({ at: 2, status: "ok" }));
    writeFileSync(path, `${readFileSync(path, "utf8")}not json\n{"v":9}\n`);
    log.append(row({ at: 3 }));
    expect(log.read().map((r) => r.at)).toEqual([1, 2, 3]);
    expect(log.read(2).map((r) => r.at)).toEqual([2, 3]);
  });

  it("compacts past maxBytes to the newest rows within half the cap", () => {
    const path = join(dir, "fusion-outcomes.jsonl");
    const maxBytes = 4_000;
    const log = new FusionOutcomeLog({ path, maxBytes, maxRows: 1_000 });
    for (let i = 0; i < 200; i += 1) log.append(row({ at: i }));
    expect(statSync(path).size).toBeLessThanOrEqual(maxBytes);
    const rows = log.read();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[rows.length - 1]!.at).toBe(199);
    // Strictly increasing: only a newest suffix is kept.
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i]!.at).toBe(rows[i - 1]!.at + 1);
    }
  });

  it("caps the rows kept at a compaction to maxRows", () => {
    const path = join(dir, "fusion-outcomes.jsonl");
    const roomy = new FusionOutcomeLog({ path, maxBytes: 1_000_000 });
    for (let i = 0; i < 100; i += 1) roomy.append(row({ at: i }));
    const tight = new FusionOutcomeLog({ path, maxBytes: 5_000, maxRows: 5 });
    tight.append(row({ at: 999 }));
    const rows = roomy.read(10_000);
    expect(rows.length).toBeLessThanOrEqual(5);
    expect(rows.at(-1)!.at).toBe(999);
  });

  it("never throws: an unwritable path just logs nothing", () => {
    const blocker = join(dir, "file");
    writeFileSync(blocker, "x");
    const log = new FusionOutcomeLog({ path: join(blocker, "sub", "log.jsonl") });
    expect(() => log.append(row())).not.toThrow();
    expect(log.read()).toEqual([]);
    expect(log.summaryLines("s1")).toEqual([]);
  });

  it("holds the summary per session, so the prefix does not move mid-session", () => {
    const path = join(dir, "fusion-outcomes.jsonl");
    const log = new FusionOutcomeLog({ path });
    for (let i = 0; i < 3; i += 1) log.append(row({ at: i }));
    const first = log.summaryLines("s1");
    expect(first).toHaveLength(1);
    expect(first[0]).toContain("failed 3 of 3");
    for (let i = 0; i < 5; i += 1) log.append(row({ at: 10 + i, status: "ok" }));
    expect(log.summaryLines("s1")).toBe(first);
    // Another process reads what this one appended.
    expect(new FusionOutcomeLog({ path }).summaryLines("s1")[0]).toContain("5 of 8 ok");
    expect(existsSync(path)).toBe(true);
  });

  it("rebuilds the summary when a new session starts on the same instance", () => {
    const path = join(dir, "fusion-outcomes.jsonl");
    const log = new FusionOutcomeLog({ path });
    expect(log.summaryLines("s1")).toEqual([]);
    for (let i = 0; i < 3; i += 1) log.append(row({ at: i }));
    // The running session keeps its prefix…
    expect(log.summaryLines("s1")).toEqual([]);
    // …and the next one, in the same long-lived process, sees the rows.
    const next = log.summaryLines("s2");
    expect(next).toHaveLength(1);
    expect(next[0]).toContain("failed 3 of 3");
  });

  it("keeps a busy session's summary while many other sessions come and go", () => {
    const path = join(dir, "fusion-outcomes.jsonl");
    const log = new FusionOutcomeLog({ path });
    const held = log.summaryLines("parent");
    for (let i = 0; i < 3; i += 1) log.append(row({ at: i }));
    for (let i = 0; i < 200; i += 1) {
      log.summaryLines(`worker-${i}`);
      expect(log.summaryLines("parent")).toBe(held);
    }
  });

  it("with the journal off, writes no rows and states no summary", () => {
    const path = join(dir, "fusion-outcomes.jsonl");
    let on = false;
    const log = new FusionOutcomeLog({ path, enabled: () => on });
    for (let i = 0; i < 3; i += 1) log.append(row({ at: i }));
    expect(existsSync(path)).toBe(false);
    on = true;
    for (let i = 0; i < 3; i += 1) log.append(row({ at: i }));
    expect(log.summaryLines("s1")).toHaveLength(1);
    on = false;
    expect(log.summaryLines("s1")).toEqual([]);
    expect(log.summaryLines("s2")).toEqual([]);
    log.append(row({ at: 99 }));
    expect(log.read()).toHaveLength(3);
  });

  it("rejects rows of another version or with an unknown status", () => {
    expect(parseOutcomeRow(JSON.stringify(row()))).not.toBeNull();
    expect(parseOutcomeRow(JSON.stringify({ ...row(), v: 2 }))).toBeNull();
    expect(parseOutcomeRow(JSON.stringify({ ...row(), status: "weird" }))).toBeNull();
    expect(parseOutcomeRow(JSON.stringify({ ...row(), model: "" }))).toBeNull();
  });
});
