/**
 * LoCoMo vitest spec — driven by `npm run eval:memory:locomo`. Skipped
 * automatically when the dataset is missing so the file is safe to
 * keep checked in.
 *
 * Configuration:
 *
 *  - `ATOMIC_AGENT_LOCOMO_PATH` — path to `locomo10.json`.
 *  - `ATOMIC_AGENT_EVAL_LLAMA_URL` — llama-server URL (the orchestrator
 *    `scripts/run-locomo.mjs` sets this automatically when it brings
 *    the managed daemon up).
 *  - `ATOMIC_AGENT_LOCOMO_PROFILES` — CSV of campaign profile names
 *    to run. Defaults to all seven.
 *  - `ATOMIC_AGENT_LOCOMO_MAX_CONVS` — cap on conversations evaluated.
 *    Defaults to `1` so the spec is fast in CI — the full 10-conv run
 *    is unlocked via the orchestrator.
 *  - `ATOMIC_AGENT_LOCOMO_MAX_QUESTIONS_PER_CONV` — cap on QA pairs
 *    per conversation. Defaults to all.
 *  - `ATOMIC_AGENT_LOCOMO_MAX_SESSIONS_PER_CONV` — cap on
 *    conversation sessions fed before QA. Defaults to all. Use for
 *    smoke runs where the full ~56-session prefill on `full_v2`
 *    would exceed the vitest timeout.
 *  - `ATOMIC_AGENT_LOCOMO_TEST_TIMEOUT_MS` — per-test vitest
 *    timeout (default 7200000 = 120 min). Bumped above the vitest
 *    default of 600s because `full_v2` on ~56 sessions × a 35B-A3B
 *    MoE legitimately takes 20–40 min wall-clock; 120 min covers
 *    even N=20 sessions per conv under the per-profile prompt
 *    budgets in `getProfilePromptBudgetMs`.
 *  - `ATOMIC_AGENT_LOCOMO_JUDGE_DISABLED` — set to `1` to skip the
 *    LLM judge post-pass (useful for CI smoke or when the judge
 *    key is intentionally absent). When the judge resolves to null
 *    (no API key, `ATOMIC_AGENT_JUDGE_DISABLED=1`), the pass is
 *    also skipped silently and `summary.md` flags it explicitly.
 *  - `ATOMIC_AGENT_LOCOMO_JUDGE_CONCURRENCY` — parallel judge HTTP
 *    calls. Default 3.
 *  - `ATOMIC_AGENT_LOCOMO_KEEP_STATE` — set to `1` to keep the temp
 *    `<stateDir>` / `<workingDir>` on disk after each conversation.
 *    Use for postmortem when long prefill runs produce empty replies
 *    — the trace at `<stateDir>/traces/<sessionId>.ndjson` reveals
 *    which session the child agent died on. Paths are appended to
 *    `summary.md`.
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  CAMPAIGN_PROFILE_NAMES,
  type CampaignProfileName,
} from "../../config/campaign-profiles.js";
import {
  loadLocomoDataset,
  LOCOMO_DEFAULT_PATH,
  type LocomoConversation,
} from "./dataset.js";
import {
  runLocomoConversation,
  summariseByCategory,
  type LocomoConversationResult,
} from "./runner.js";
import {
  appendJsonl,
  startReportRun,
  reportPath,
  writeCsv,
  writeMarkdownSummary,
} from "../../harness/reports.js";
import { resolveJudge } from "../../harness/judge.js";
import {
  judgeLocomoResults,
  summariseJudgeByCategory,
  type LocomoJudgeCategorySummary,
  type LocomoJudgeVerdict,
} from "./locomo-judge.js";
import {
  appendRunDiagnostics,
  buildDiagnosticsEntry,
  dumpKeptStderr,
} from "./diagnostics-writer.js";

const DATASET_PATH = process.env.ATOMIC_AGENT_LOCOMO_PATH ?? LOCOMO_DEFAULT_PATH;
const LLAMA_URL = process.env.ATOMIC_AGENT_EVAL_LLAMA_URL ?? null;
const PROFILES = parseProfiles(process.env.ATOMIC_AGENT_LOCOMO_PROFILES);
const MAX_CONVS = parseInt(
  process.env.ATOMIC_AGENT_LOCOMO_MAX_CONVS ?? "1",
  10,
);
const MAX_QUESTIONS_PER_CONV = process.env
  .ATOMIC_AGENT_LOCOMO_MAX_QUESTIONS_PER_CONV
  ? parseInt(process.env.ATOMIC_AGENT_LOCOMO_MAX_QUESTIONS_PER_CONV, 10)
  : undefined;
const MAX_SESSIONS_PER_CONV = process.env
  .ATOMIC_AGENT_LOCOMO_MAX_SESSIONS_PER_CONV
  ? parseInt(process.env.ATOMIC_AGENT_LOCOMO_MAX_SESSIONS_PER_CONV, 10)
  : undefined;
const TEST_TIMEOUT_MS = parseInt(
  process.env.ATOMIC_AGENT_LOCOMO_TEST_TIMEOUT_MS ?? "7200000",
  10,
);
const JUDGE_DISABLED =
  process.env.ATOMIC_AGENT_LOCOMO_JUDGE_DISABLED === "1";
const JUDGE_CONCURRENCY = parseInt(
  process.env.ATOMIC_AGENT_LOCOMO_JUDGE_CONCURRENCY ?? "3",
  10,
);
const KEEP_STATE = process.env.ATOMIC_AGENT_LOCOMO_KEEP_STATE === "1";
// Whitelist by `sample_id` (comma-separated). Applied BEFORE
// MAX_CONVS slicing so e.g. INCLUDE_IDS=conv-30 + MAX_CONVS=1
// targets that specific conversation without reshuffling the
// dataset. Empty / unset = no filter, fall back to dataset order.
const INCLUDE_IDS = (process.env.ATOMIC_AGENT_LOCOMO_INCLUDE_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

const hasDataset = existsSync(resolve(DATASET_PATH));
const hasLlama = typeof LLAMA_URL === "string" && LLAMA_URL.length > 0;

(hasDataset && hasLlama ? describe : describe.skip)(
  "LoCoMo — multi-profile",
  () => {
    let dataset: LocomoConversation[];
    let report: ReturnType<typeof startReportRun>;

    it("loads and caps the dataset", () => {
      const all = loadLocomoDataset({ path: DATASET_PATH });
      const filtered =
        INCLUDE_IDS.length > 0
          ? all.filter((c) => INCLUDE_IDS.includes(c.sampleId))
          : all;
      dataset = filtered.slice(0, MAX_CONVS);
      report = startReportRun({ label: "locomo" });
      expect(dataset.length).toBeGreaterThan(0);
    });

    it(
      "runs each profile against the dataset and writes per-question NDJSON + per-category CSV",
      async () => {
        const allResults: LocomoConversationResult[] = [];
        const ndjsonPath = reportPath(report, "questions.ndjson");

        for (const profile of PROFILES) {
          for (const conv of dataset) {
            const result = await runLocomoConversation({
              profile,
              llamaUrl: LLAMA_URL!,
              conversation: conv,
              maxQuestions: MAX_QUESTIONS_PER_CONV,
              maxSessions: MAX_SESSIONS_PER_CONV,
              interPromptDrainMs: profile === "full_v2" ? 1500 : 0,
              postLastReplyDrainMs: profile === "full_v2" ? 60_000 : 0,
              keepStateDir: KEEP_STATE,
            });
            allResults.push(result);
            // Always append a diagnostics block — pre-existing pattern of
            // logging only on `!result.ok` lost critical postmortem data
            // when the harness was killed mid-run (see commit message).
            // The diagnostics file is append-only, so partial runs keep
            // every completed scenario's record.
            const diagPath = reportPath(report, "run-diagnostics.txt");
            const diagEntry = buildDiagnosticsEntry({
              profile: result.profile,
              conversationId: result.conversationId,
              ok: result.ok,
              exitCode: result.exitCode,
              signal: result.signal,
              timedOut: result.timedOut,
              subprocessDurationMs: result.subprocessDurationMs,
              sessionId: result.sessionId,
              questions: result.questions,
              keptStateDir: result.keptStateDir,
              keptWorkingDir: result.keptWorkingDir,
              keptTracePath: result.keptTracePath,
              stderrTail: result.stderrTail,
            });
            appendRunDiagnostics(diagPath, diagEntry);
            dumpKeptStderr(result.keptStateDir, result.stderrAll);
            if (!result.ok) {
              process.stderr.write(
                `[locomo.eval] conversation ${result.conversationId} on profile ${profile} ` +
                  `did NOT complete cleanly: exitCode=${result.exitCode}, signal=${result.signal ?? "-"}, timedOut=${result.timedOut}\n` +
                  `[locomo.eval] stderrTail (last 800 chars):\n${result.stderrTail.slice(-800)}\n`,
              );
              if (result.keptStateDir) {
                process.stderr.write(
                  `[locomo.eval] state dir kept at: ${result.keptStateDir}\n` +
                    `[locomo.eval] working dir kept at: ${result.keptWorkingDir}\n` +
                    `[locomo.eval] trace kept at:     ${result.keptTracePath ?? "-"}\n`,
                );
              }
            }
            for (const q of result.questions) {
              appendJsonl(ndjsonPath, q);
            }
          }
        }

        const summary = summariseByCategory(allResults);
        writeCsv(
          reportPath(report, "by-category.csv"),
          [
            "profile",
            "category",
            "questions",
            "substringAccuracy",
            "abstentionAccuracy",
            "meanPromptTokens",
            "p50PromptTokens",
            "p95PromptTokens",
            "meanDurationMs",
            "p50DurationMs",
            "p95DurationMs",
            "meanStepCount",
          ],
          summary as unknown as readonly Record<string, unknown>[],
        );

        // -------------------------------------------------------
        // LLM judge post-pass. Optional; skipped silently when no
        // judge config is available (or explicitly disabled). Never
        // throws — failures land as score=1, available=false in the
        // verdict stream so aggregates degrade safely.
        // -------------------------------------------------------
        let judgeVerdicts: LocomoJudgeVerdict[] = [];
        let judgeSummary: LocomoJudgeCategorySummary[] = [];
        let judgeStatus: "skipped_config" | "skipped_disabled" | "ran" =
          JUDGE_DISABLED ? "skipped_disabled" : "skipped_config";
        if (!JUDGE_DISABLED) {
          const resolved = resolveJudge();
          if (resolved) {
            judgeStatus = "ran";
            const judgeInputs = allResults.flatMap((conv) => {
              const convData = dataset.find(
                (c) => c.sampleId === conv.conversationId,
              );
              const qa = convData ? convData.qa : [];
              return conv.questions.map((qr, i) => ({
                profile: qr.profile,
                conversationId: qr.conversationId,
                question: qa[i] ?? {
                  question: qr.question,
                  answer: qr.goldAnswer,
                  category: 1 as const,
                  categoryLabel: qr.category,
                  evidence: [],
                  adversarialAnswer: null,
                },
                reply: qr.assistantReply,
              }));
            });
            judgeVerdicts = await judgeLocomoResults({
              judge: resolved.client,
              inputs: judgeInputs,
              concurrency: JUDGE_CONCURRENCY,
            });
            const judgeNdjsonPath = reportPath(report, "judge.ndjson");
            for (const v of judgeVerdicts) appendJsonl(judgeNdjsonPath, v);
            judgeSummary = summariseJudgeByCategory(judgeVerdicts);
            writeCsv(
              reportPath(report, "by-category-judge.csv"),
              [
                "profile",
                "category",
                "graded",
                "judgeAvailable",
                "meanJudgeScore",
                "judgeAccAtFour",
                "judgeAccAtFive",
              ],
              judgeSummary as unknown as readonly Record<string, unknown>[],
            );
          }
        }

        const failedRuns = allResults.filter((r) => !r.ok);

        const lines: string[] = [
          "# LoCoMo run",
          "",
          `- Dataset: ${DATASET_PATH}`,
          `- Conversations: ${dataset.length}`,
          `- Profiles: ${PROFILES.join(", ")}`,
          `- maxQuestions per conv: ${MAX_QUESTIONS_PER_CONV ?? "all"}`,
          `- maxSessions per conv: ${MAX_SESSIONS_PER_CONV ?? "all"}`,
          `- Judge: ${judgeStatusLabel(judgeStatus)}`,
          ...(failedRuns.length > 0
            ? [
                "",
                `> WARNING: ${failedRuns.length}/${allResults.length} (profile, conversation) runs did NOT complete cleanly.`,
                "> The empty replies on those runs will floor the judge to score=1 and skew the means downward.",
                ...failedRuns.map(
                  (r) =>
                    `>   - ${r.profile} / ${r.conversationId}: exit=${r.exitCode}, signal=${r.signal ?? "-"}, timedOut=${r.timedOut}` +
                    (r.keptStateDir ? `, state=${r.keptStateDir}` : "") +
                    (r.keptTracePath ? `, trace=${r.keptTracePath}` : ""),
                ),
              ]
            : []),
          "",
          "## Substring accuracy by profile × category",
          "",
          "| profile | category | n | substring-acc | abstention-acc |",
          "|---|---|---|---|---|",
        ];
        for (const row of summary) {
          lines.push(
            `| ${row.profile} | ${row.category} | ${row.questions} | ` +
              `${row.substringAccuracy.toFixed(2)} | ${row.abstentionAccuracy.toFixed(2)} |`,
          );
        }
        lines.push(
          "",
          "## Cost: prompt tokens per question (mean / p50 / p95)",
          "",
          "| profile | category | n | mean | p50 | p95 |",
          "|---|---|---|---|---|---|",
        );
        for (const row of summary) {
          lines.push(
            `| ${row.profile} | ${row.category} | ${row.questions} | ` +
              `${row.meanPromptTokens.toFixed(0)} | ${row.p50PromptTokens.toFixed(0)} | ${row.p95PromptTokens.toFixed(0)} |`,
          );
        }
        lines.push(
          "",
          "## Latency: wall-clock per question, ms (mean / p50 / p95)",
          "",
          "| profile | category | n | mean | p50 | p95 |",
          "|---|---|---|---|---|---|",
        );
        for (const row of summary) {
          lines.push(
            `| ${row.profile} | ${row.category} | ${row.questions} | ` +
              `${row.meanDurationMs.toFixed(0)} | ${row.p50DurationMs.toFixed(0)} | ${row.p95DurationMs.toFixed(0)} |`,
          );
        }
        if (judgeStatus === "ran") {
          lines.push(
            "",
            "## LLM judge accuracy by profile × category (1..5 scale)",
            "",
            "| profile | category | n | mean-judge | judgeAcc≥4 | judgeAcc=5 | judgeAvail |",
            "|---|---|---|---|---|---|---|",
          );
          for (const row of judgeSummary) {
            lines.push(
              `| ${row.profile} | ${row.category} | ${row.graded} | ` +
                `${row.meanJudgeScore.toFixed(2)} | ${row.judgeAccAtFour.toFixed(2)} | ` +
                `${row.judgeAccAtFive.toFixed(2)} | ${row.judgeAvailable}/${row.graded} |`,
            );
          }
        }
        writeMarkdownSummary(reportPath(report, "summary.md"), lines);

        expect(summary.length).toBeGreaterThan(0);
      },
      TEST_TIMEOUT_MS,
    );
  },
);

function judgeStatusLabel(
  status: "skipped_config" | "skipped_disabled" | "ran",
): string {
  switch (status) {
    case "ran": {
      const model =
        process.env.ATOMIC_AGENT_JUDGE_MODEL ?? "openai/gpt-5.4-mini";
      return `ran (${model} via OpenRouter)`;
    }
    case "skipped_disabled":
      return "SKIPPED (ATOMIC_AGENT_LOCOMO_JUDGE_DISABLED=1)";
    case "skipped_config":
      return "SKIPPED (no OPENROUTER_API_KEY / ATOMIC_AGENT_JUDGE_DISABLED)";
  }
}

function parseProfiles(raw: string | undefined): CampaignProfileName[] {
  if (!raw) return [...CAMPAIGN_PROFILE_NAMES];
  const requested = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const known = new Set(CAMPAIGN_PROFILE_NAMES);
  const out: CampaignProfileName[] = [];
  for (const name of requested) {
    if (known.has(name as CampaignProfileName)) {
      out.push(name as CampaignProfileName);
    } else {
      process.stderr.write(
        `[locomo.eval] unknown profile '${name}' — skipping\n`,
      );
    }
  }
  return out.length > 0 ? out : [...CAMPAIGN_PROFILE_NAMES];
}
