import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendRunDiagnostics,
  buildDiagnosticsEntry,
  computeReasonHistogram,
  dumpKeptStderr,
  formatDiagnosticsEntry,
  STDERR_TAIL_MAX_LEN,
  type DiagnosticsEntry,
  type QuestionRow,
} from "./diagnostics-writer.js";

const baseEntry = (overrides: Partial<DiagnosticsEntry> = {}): DiagnosticsEntry => ({
  profile: "full_v2",
  conversationId: "conv-26",
  ok: true,
  exitCode: 0,
  signal: null,
  timedOut: false,
  subprocessDurationMs: 3_600_000,
  sessionId: "sess-abc",
  questionsScored: 100,
  emptyReplies: 0,
  reasonHistogram: { reply: 100 },
  failureCategoryHistogram: {},
  keptStateDir: null,
  keptWorkingDir: null,
  keptTracePath: null,
  stderrTail: "",
  ...overrides,
});

describe("computeReasonHistogram", () => {
  it("counts reply / max_steps / failed mix", () => {
    const questions: QuestionRow[] = [
      { assistantReply: "ok", reason: "reply", failureCategory: null },
      { assistantReply: "ok", reason: "reply", failureCategory: null },
      { assistantReply: "", reason: "max_steps", failureCategory: null },
      { assistantReply: "", reason: "failed", failureCategory: "model" },
      { assistantReply: "", reason: "failed", failureCategory: "grammar" },
      { assistantReply: "", reason: "failed", failureCategory: "model" },
    ];
    const { reasonHistogram, failureCategoryHistogram } = computeReasonHistogram(questions);
    expect(reasonHistogram).toEqual({ reply: 2, max_steps: 1, failed: 3 });
    expect(failureCategoryHistogram).toEqual({ model: 2, grammar: 1 });
  });

  it("folds `null` reason into <no-turn> sentinel", () => {
    const questions: QuestionRow[] = [
      { assistantReply: "", reason: null, failureCategory: null },
      { assistantReply: "", reason: null, failureCategory: null },
      { assistantReply: "ok", reason: "reply", failureCategory: null },
    ];
    const { reasonHistogram } = computeReasonHistogram(questions);
    expect(reasonHistogram).toEqual({ "<no-turn>": 2, reply: 1 });
  });

  it("ignores failureCategory when reason is not 'failed'", () => {
    const questions: QuestionRow[] = [
      { assistantReply: "", reason: "cancelled", failureCategory: "cancelled" },
      { assistantReply: "ok", reason: "reply", failureCategory: "model" },
    ];
    const { failureCategoryHistogram } = computeReasonHistogram(questions);
    expect(failureCategoryHistogram).toEqual({});
  });
});

describe("buildDiagnosticsEntry", () => {
  it("counts empty replies and threads histograms through", () => {
    const entry = buildDiagnosticsEntry({
      profile: "full_v2",
      conversationId: "conv-26",
      ok: true,
      exitCode: 0,
      signal: null,
      timedOut: false,
      subprocessDurationMs: 1_000,
      sessionId: "s1",
      questions: [
        { assistantReply: "answered", reason: "reply", failureCategory: null },
        { assistantReply: " ", reason: "max_steps", failureCategory: null },
        { assistantReply: "", reason: null, failureCategory: null },
      ],
      keptStateDir: null,
      keptWorkingDir: null,
      keptTracePath: null,
      stderrTail: "",
    });
    expect(entry.questionsScored).toBe(3);
    expect(entry.emptyReplies).toBe(2);
    expect(entry.reasonHistogram).toEqual({ reply: 1, max_steps: 1, "<no-turn>": 1 });
  });
});

describe("formatDiagnosticsEntry", () => {
  it("emits a stable, sorted block with all required fields", () => {
    const out = formatDiagnosticsEntry(
      baseEntry({
        ok: false,
        exitCode: null,
        signal: "SIGKILL",
        timedOut: true,
        questionsScored: 148,
        emptyReplies: 54,
        reasonHistogram: { reply: 94, max_steps: 54 },
        failureCategoryHistogram: {},
        keptStateDir: "/tmp/foo-state",
        keptWorkingDir: "/tmp/foo-work",
        keptTracePath: "/tmp/foo-state/traces/sess-abc.ndjson",
        stderrTail: "child stderr line 1\nchild stderr line 2",
      }),
    );
    expect(out).toContain("## full_v2 / conv-26");
    expect(out).toContain("ok:          false");
    expect(out).toContain("signal:      SIGKILL");
    expect(out).toContain("timedOut:    true");
    expect(out).toContain("emptyReplies:    54");
    // reason histogram keys are sorted alphabetically
    const reasonBlock = out.split("reasonHistogram:\n")[1].split("failureCategoryHistogram:")[0];
    const lines = reasonBlock.trim().split("\n").map((s) => s.trim());
    expect(lines).toEqual(["max_steps: 54", "reply: 94"]);
    expect(out).toContain("keptStateDir:    /tmp/foo-state");
    expect(out).toContain("child stderr line 2");
    expect(out.endsWith("---\n")).toBe(true);
  });

  it("clamps stderr to STDERR_TAIL_MAX_LEN", () => {
    const huge = "x".repeat(STDERR_TAIL_MAX_LEN * 3);
    const out = formatDiagnosticsEntry(baseEntry({ stderrTail: huge }));
    const block = out.split("stderrTail (last 4KB):\n")[1].split("---")[0].trimEnd();
    expect(block.length).toBe(STDERR_TAIL_MAX_LEN);
  });

  it("omits kept-paths when not set", () => {
    const out = formatDiagnosticsEntry(baseEntry({ keptStateDir: null }));
    expect(out).not.toContain("keptStateDir");
  });

  it("prints '(no turns recorded)' when reason histogram is empty", () => {
    const out = formatDiagnosticsEntry(baseEntry({ reasonHistogram: {} }));
    expect(out).toContain("(no turns recorded)");
  });
});

describe("appendRunDiagnostics + dumpKeptStderr (filesystem)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "loc-diag-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("appends multiple entries to the same file", () => {
    const path = join(tmp, "nested", "run-diagnostics.txt");
    appendRunDiagnostics(path, baseEntry({ conversationId: "conv-1" }));
    appendRunDiagnostics(path, baseEntry({ conversationId: "conv-2" }));
    const body = readFileSync(path, "utf8");
    expect(body).toContain("## full_v2 / conv-1");
    expect(body).toContain("## full_v2 / conv-2");
    expect(body.split("---").length).toBe(3); // two blocks + trailing
  });

  it("dumpKeptStderr no-ops when keptStateDir is null", () => {
    const r = dumpKeptStderr(null, "anything");
    expect(r).toEqual({ written: false, path: null });
  });

  it("dumpKeptStderr writes stderr.log under kept state dir", () => {
    const r = dumpKeptStderr(tmp, "stderr line 1\nstderr line 2\n");
    expect(r.written).toBe(true);
    expect(r.path).toBe(`${tmp}/stderr.log`);
    expect(readFileSync(r.path!, "utf8")).toContain("stderr line 2");
  });

  it("dumpKeptStderr is append-friendly across calls", () => {
    dumpKeptStderr(tmp, "first\n");
    dumpKeptStderr(tmp, "second\n");
    const body = readFileSync(`${tmp}/stderr.log`, "utf8");
    expect(body).toBe("first\nsecond\n");
    // Ensure file exists (statSync would throw otherwise).
    statSync(`${tmp}/stderr.log`);
  });
});
