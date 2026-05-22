/**
 * LongMemEval vitest spec — driven by `npm run eval:memory:longmemeval`.
 * Skipped when the dataset is missing or `ATOMIC_AGENT_EVAL_LLAMA_URL`
 * is unset.
 *
 * Configuration:
 *
 *  - `ATOMIC_AGENT_LONGMEMEVAL_PATH` — path to `longmemeval_s.json`.
 *  - `ATOMIC_AGENT_EVAL_LLAMA_URL` — llama-server URL.
 *  - `ATOMIC_AGENT_LONGMEMEVAL_PROFILES` — CSV of profiles to run.
 *    Defaults to all seven.
 *  - `ATOMIC_AGENT_LONGMEMEVAL_MAX_ROWS` — cap on rows. Defaults to
 *    `20` so the CI shape is bounded; the full ~500-row run goes
 *    through explicit env override.
 *  - `ATOMIC_AGENT_LONGMEMEVAL_AXES` — CSV of axes to keep. Defaults
 *    to all five.
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  CAMPAIGN_PROFILE_NAMES,
  type CampaignProfileName,
} from "../../config/campaign-profiles.js";
import {
  loadLongMemEvalDataset,
  LONGMEMEVAL_DEFAULT_PATH,
  type LongMemEvalRow,
  type LongMemEvalAxis,
} from "./dataset.js";
import {
  runLongMemEvalRow,
  summariseByAxis,
  type LongMemEvalRowResult,
} from "./runner.js";
import {
  appendJsonl,
  startReportRun,
  reportPath,
  writeCsv,
  writeMarkdownSummary,
} from "../../harness/reports.js";

const DATASET_PATH =
  process.env.ATOMIC_AGENT_LONGMEMEVAL_PATH ?? LONGMEMEVAL_DEFAULT_PATH;
const LLAMA_URL = process.env.ATOMIC_AGENT_EVAL_LLAMA_URL ?? null;
const PROFILES = parseProfiles(process.env.ATOMIC_AGENT_LONGMEMEVAL_PROFILES);
const AXES = parseAxes(process.env.ATOMIC_AGENT_LONGMEMEVAL_AXES);
const MAX_ROWS = parseInt(
  process.env.ATOMIC_AGENT_LONGMEMEVAL_MAX_ROWS ?? "20",
  10,
);

const hasDataset = existsSync(resolve(DATASET_PATH));
const hasLlama = typeof LLAMA_URL === "string" && LLAMA_URL.length > 0;

(hasDataset && hasLlama ? describe : describe.skip)(
  "LongMemEval — multi-profile",
  () => {
    let dataset: LongMemEvalRow[];
    let report: ReturnType<typeof startReportRun>;

    it("loads and filters the dataset by axis + cap", () => {
      const all = loadLongMemEvalDataset({ path: DATASET_PATH });
      dataset = all.filter((r) => AXES.includes(r.axis)).slice(0, MAX_ROWS);
      report = startReportRun({ label: "longmemeval" });
      expect(dataset.length).toBeGreaterThan(0);
    });

    it("runs each profile against the dataset", async () => {
      const allResults: LongMemEvalRowResult[] = [];
      const ndjsonPath = reportPath(report, "questions.ndjson");

      for (const profile of PROFILES) {
        for (const row of dataset) {
          const r = await runLongMemEvalRow({
            profile,
            llamaUrl: LLAMA_URL!,
            row,
            interPromptDrainMs: profile === "full_v2" ? 1500 : 0,
            postLastReplyDrainMs: profile === "full_v2" ? 5000 : 0,
          });
          allResults.push(r);
          appendJsonl(ndjsonPath, r.question);
        }
      }

      const summary = summariseByAxis(allResults);
      writeCsv(
        reportPath(report, "by-axis.csv"),
        [
          "profile",
          "axis",
          "rows",
          "substringAccuracy",
          "abstentionAccuracy",
          "meanPromptTokens",
          "meanDurationMs",
          "meanStepCount",
        ],
        summary as unknown as readonly Record<string, unknown>[],
      );

      const lines: string[] = [
        "# LongMemEval run",
        "",
        `- Dataset: ${DATASET_PATH}`,
        `- Rows: ${dataset.length}`,
        `- Profiles: ${PROFILES.join(", ")}`,
        `- Axes: ${AXES.join(", ")}`,
        "",
        "## Accuracy by profile × axis",
        "",
        "| profile | axis | n | substring-acc | abstention-acc | meanTokens | meanMs |",
        "|---|---|---|---|---|---|---|",
      ];
      for (const row of summary) {
        lines.push(
          `| ${row.profile} | ${row.axis} | ${row.rows} | ` +
            `${row.substringAccuracy.toFixed(2)} | ${row.abstentionAccuracy.toFixed(2)} | ` +
            `${row.meanPromptTokens.toFixed(0)} | ${row.meanDurationMs.toFixed(0)} |`,
        );
      }
      writeMarkdownSummary(reportPath(report, "summary.md"), lines);

      expect(summary.length).toBeGreaterThan(0);
    });
  },
);

function parseProfiles(raw: string | undefined): CampaignProfileName[] {
  if (!raw) return [...CAMPAIGN_PROFILE_NAMES];
  const known = new Set(CAMPAIGN_PROFILE_NAMES);
  const out: CampaignProfileName[] = [];
  for (const name of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (known.has(name as CampaignProfileName)) {
      out.push(name as CampaignProfileName);
    }
  }
  return out.length > 0 ? out : [...CAMPAIGN_PROFILE_NAMES];
}

function parseAxes(raw: string | undefined): LongMemEvalAxis[] {
  const all: LongMemEvalAxis[] = [
    "information_extraction",
    "multi_session_reasoning",
    "temporal_reasoning",
    "knowledge_updates",
    "abstention",
  ];
  if (!raw) return all;
  const known = new Set(all);
  const out: LongMemEvalAxis[] = [];
  for (const a of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (known.has(a as LongMemEvalAxis)) out.push(a as LongMemEvalAxis);
  }
  return out.length > 0 ? out : all;
}
