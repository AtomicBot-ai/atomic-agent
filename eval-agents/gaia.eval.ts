import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { resolve } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadEvalAgentsEnvFile } from "./harness/load-env.js";

loadEvalAgentsEnvFile();

import { listAgentAdapters } from "./adapters/index.js";
import { appendCsvRow, appendJsonlRow } from "./harness/append-report.js";
import { captureEnvironmentSnapshot } from "./harness/environment-lock.js";
import { loadGaiaRows } from "./harness/load-gaia-rows.js";
import { runGaiaCase } from "./harness/run-gaia-case.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, "-");
const REPORT_DIR = resolve(HERE, "reports", `run-${TIMESTAMP}`);
const CSV_PATH = resolve(REPORT_DIR, "matrix.csv");
const JSONL_PATH = resolve(REPORT_DIR, "matrix.jsonl");
const TRACES_DIR = resolve(REPORT_DIR, "traces");

const chatUrl = process.env.ATOMIC_AGENT_EVAL_LLAMA_URL ?? "";
const embedUrl = process.env.ATOMIC_AGENT_EVAL_EMBED_URL ?? null;

function parseAgentFilter(): string[] | undefined {
  const raw = process.env.ATOMIC_AGENT_EVAL_AGENTS;
  if (!raw) return undefined;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function loadRows() {
  const source = (process.env.ATOMIC_AGENT_GAIA_SOURCE ?? "auto") as
    | "fixtures"
    | "hf"
    | "auto";
  const level = process.env.ATOMIC_AGENT_GAIA_LEVEL
    ? Number(process.env.ATOMIC_AGENT_GAIA_LEVEL)
    : null;
  const limit = process.env.ATOMIC_AGENT_GAIA_LIMIT
    ? Number(process.env.ATOMIC_AGENT_GAIA_LIMIT)
    : null;
  const taskIds = process.env.ATOMIC_AGENT_GAIA_TASK_IDS
    ? process.env.ATOMIC_AGENT_GAIA_TASK_IDS.split(",").map((s) => s.trim()).filter(Boolean)
    : null;
  return loadGaiaRows({ source, level, limit, taskIds });
}

beforeAll(async () => {
  loadEvalAgentsEnvFile();
  mkdirSync(REPORT_DIR, { recursive: true });
  if (chatUrl) {
    const snap = await captureEnvironmentSnapshot({
      chatUrl,
      embeddingUrl: embedUrl,
    });
    writeFileSync(
      resolve(REPORT_DIR, "environment.json"),
      `${JSON.stringify(snap, null, 2)}\n`,
      "utf8",
    );
  }
});

afterAll(() => {
  // reports are persisted under REPORT_DIR
});

describe("GAIA multi-agent matrix", () => {
  const rows = loadRows();
  const adapters = listAgentAdapters(parseAgentFilter());

  if (rows.length === 0 || adapters.length === 0) {
    test("matrix is empty (no rows or no adapters selected)", () => {
      // Guard so an empty filter/dataset does not surface as a vitest
      // "no test found" hard failure in the orchestrators.
      expect.soft(rows.length, "no GAIA rows loaded").toBeGreaterThanOrEqual(0);
      expect.soft(adapters.length, "no adapters selected").toBeGreaterThanOrEqual(0);
    });
  }

  for (const adapter of adapters) {
    describe(adapter.label, () => {
      for (const row of rows) {
        const title = `[L${row.Level}] ${row.task_id}`;
        test(title, async () => {
          if (!chatUrl) {
            expect.fail("ATOMIC_AGENT_EVAL_LLAMA_URL is required for agent runs");
          }

          const result = await runGaiaCase({
            adapter,
            row,
            chatUrl,
            embedUrl,
            maxSteps: Number(process.env.ATOMIC_AGENT_GAIA_MAX_STEPS ?? "30"),
            timeoutMs: Number(process.env.ATOMIC_AGENT_GAIA_TIMEOUT_MS ?? "600000"),
            tracesOutDir: TRACES_DIR,
          });

          appendCsvRow(CSV_PATH, row, result);
          appendJsonlRow(JSONL_PATH, row, result);

          if (result.skipped) {
            expect.soft(result.skipReason).toBeTruthy();
            return;
          }

          expect.soft(result.error, result.error ?? "no error").toBeNull();
          expect(result.correct, `extracted=${result.extractedAnswer} gold=${row["Final answer"]}`).toBe(
            true,
          );
        });
      }
    });
  }
});

describe("GAIA smoke (scoring only)", () => {
  test("questionScorer smoke fixtures are self-consistent", async () => {
    const { questionScorer } = await import("./harness/score-gaia.js");
    const rows = loadGaiaRows({ source: "fixtures" });
    for (const row of rows) {
      expect(questionScorer(row["Final answer"], row["Final answer"])).toBe(true);
    }
  });
});
