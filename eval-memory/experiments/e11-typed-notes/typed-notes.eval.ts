import { beforeAll, describe, expect, it } from "vitest";

import { loadMemoryEvalEnvFile } from "../../harness/load-env.js";
import {
  appendJsonl,
  reportPath,
  startReportRun,
  writeMarkdownSummary,
  type ReportRun,
} from "../../harness/reports.js";

import { runE11, type E11Report } from "./runner.js";

/**
 * E11 — Memory Fabric v2.5 Phase C (typed NOTE extraction).
 *
 * Sub-scenarios:
 *  - typed-roundtrip — event + behavior prompts produce
 *    `type:event` and `type:behavior` tags.
 *  - forbidden-soft — soft assertion: ≤30% of 10 trivial cases
 *    may misfire to the forbidden type (Q2 soft).
 *  - legacy-compat — pre-flag rows survive a flag-flipped second
 *    session AND new rows pick up the type tags.
 */

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const MAX_FORBIDDEN_SHARE = envNumber(
  "ATOMIC_AGENT_E11_MAX_FORBIDDEN_SHARE",
  0.3,
);

describe.sequential("E11 — typed NOTE extraction (v2.5 Phase C)", () => {
  let report: E11Report | null = null;
  let run: ReportRun | null = null;
  let skipReason: string | null = null;

  beforeAll(async () => {
    loadMemoryEvalEnvFile();
    const llamaUrl = process.env.ATOMIC_AGENT_EVAL_LLAMA_URL;
    if (!llamaUrl) {
      skipReason =
        "ATOMIC_AGENT_EVAL_LLAMA_URL not set; bring up the daemon via scripts/run-v25.mjs";
      return;
    }
    run = startReportRun({ label: "e11" });
    report = await runE11(
      { llamaUrl },
      { maxForbiddenShare: MAX_FORBIDDEN_SHARE },
    );
    writeE11Reports(run, report);
  }, 30 * 60 * 1000);

  it("typed-roundtrip writes the expected type:* tags", () => {
    if (skipReason) {
      console.warn(`[E11] skipped — ${skipReason}`);
      return;
    }
    expect(report).not.toBeNull();
    const row = report!.results.find((r) => r.id === "typed-roundtrip");
    expect(row).toBeDefined();
    expect(
      row!.ok,
      `typed-roundtrip failed: ${row!.failReasons.join("; ")}`,
    ).toBe(true);
  });

  it("forbidden-soft stays within the per-type forbidden ceiling", () => {
    if (skipReason) return;
    expect(report).not.toBeNull();
    const row = report!.results.find((r) => r.id === "forbidden-soft");
    expect(row).toBeDefined();
    expect(
      row!.ok,
      `forbidden-soft failed: ${row!.failReasons.join("; ")}`,
    ).toBe(true);
  });

  it("legacy-compat preserves pre-flag rows AND adds typed rows post-flag", () => {
    if (skipReason) return;
    expect(report).not.toBeNull();
    const row = report!.results.find((r) => r.id === "legacy-compat");
    expect(row).toBeDefined();
    expect(
      row!.ok,
      `legacy-compat failed: ${row!.failReasons.join("; ")}`,
    ).toBe(true);
  });
});

function writeE11Reports(runRow: ReportRun, report: E11Report): void {
  const jsonlPath = reportPath(runRow, "e11", "e11-results.jsonl");
  appendJsonl(jsonlPath, { type: "aggregate", ...report.aggregate });
  for (const r of report.results) {
    if (r.id === "typed-roundtrip") {
      appendJsonl(jsonlPath, {
        type: "scenario",
        id: r.id,
        ok: r.ok,
        prompts: r.prompts,
        rowsAfter: r.rowsAfter,
        typesObserved: r.typesObserved,
        expectedTypes: r.expectedTypes,
        failReasons: r.failReasons,
        durationMs: r.durationMs,
      });
    } else if (r.id === "forbidden-soft") {
      appendJsonl(jsonlPath, {
        type: "scenario",
        id: r.id,
        ok: r.ok,
        cases: r.cases,
        forbiddenHits: r.forbiddenHits,
        forbiddenShare: r.forbiddenShare,
        maxAllowedShare: r.maxAllowedShare,
        failReasons: r.failReasons,
        durationMs: r.durationMs,
      });
      for (const pc of r.perCase) {
        appendJsonl(jsonlPath, { type: "forbidden-case", ...pc });
      }
    } else {
      appendJsonl(jsonlPath, {
        type: "scenario",
        id: r.id,
        ok: r.ok,
        legacyRowCountAfterS1: r.legacyRowCountAfterS1,
        legacyRowCountAfterS2: r.legacyRowCountAfterS2,
        typedRowsAddedInS2: r.typedRowsAddedInS2,
        failReasons: r.failReasons,
        durationMs: r.durationMs,
      });
    }
  }

  const lines: string[] = [
    "# E11 — typed NOTE extraction (v2.5 Phase C)",
    "",
    `scenarios: ${report.aggregate.scenarios}, passes: ${report.aggregate.passes}, failures: ${report.aggregate.failures}`,
    "",
    "## Per scenario",
    "",
  ];
  for (const r of report.results) {
    lines.push(`### ${r.id} — ${r.ok ? "pass" : "fail"}`);
    if (r.id === "typed-roundtrip") {
      lines.push(
        `- rows after: ${r.rowsAfter}`,
        `- expected types: ${r.expectedTypes.join(", ")}`,
        `- observed types: ${r.typesObserved.join(", ") || "(none)"}`,
      );
    } else if (r.id === "forbidden-soft") {
      lines.push(
        `- cases: ${r.cases}, forbidden hits: ${r.forbiddenHits}, share: ${r.forbiddenShare.toFixed(3)} (ceiling ${r.maxAllowedShare.toFixed(3)})`,
      );
    } else {
      lines.push(
        `- legacy rows after S1: ${r.legacyRowCountAfterS1}, after S2: ${r.legacyRowCountAfterS2}, new typed: ${r.typedRowsAddedInS2}`,
      );
    }
    if (!r.ok) lines.push(`- failures: ${r.failReasons.join("; ")}`);
    lines.push("");
  }
  writeMarkdownSummary(reportPath(runRow, "e11", "e11-summary.md"), lines);
}
