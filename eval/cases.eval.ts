import { afterAll, beforeAll, describe, test, expect } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EVAL_CASES } from "./cases/index.js";
import { runCase } from "./harness/run-case.js";
import { startMockHttp, type MockHttpHandle } from "./harness/start-mock-http.js";
import { appendReportRow } from "./harness/append-report-row.js";
import { appendJsonlRow } from "./harness/append-jsonl-row.js";
import {
  createJudgeClient,
  loadJudgeConfigFromEnv,
} from "./harness/judge-client.js";
import type { JudgeClient } from "./harness/judge-types.js";

/**
 * Entry point for the eval suite. Spins up the local mock HTTP server,
 * builds the judge client (or null when disabled), iterates every case
 * in `EVAL_CASES`, and writes one CSV row + one JSONL record per case.
 *
 * Sequential execution is enforced by `vitest.config.ts` (single fork,
 * fileParallelism: false). The shared llama-server slot pool would race
 * on parallel cases.
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, "-");
const CSV_PATH = resolve(HERE, "reports", `run-${TIMESTAMP}.csv`);
const JSONL_PATH = resolve(HERE, "reports", `run-${TIMESTAMP}.jsonl`);

let mockHttp: MockHttpHandle | null = null;
let judge: JudgeClient | null = null;

beforeAll(async () => {
  mockHttp = await startMockHttp();
  const judgeConfig = loadJudgeConfigFromEnv();
  judge = judgeConfig ? createJudgeClient(judgeConfig) : null;
});

afterAll(async () => {
  if (mockHttp) await mockHttp.close();
  mockHttp = null;
  judge = null;
});

describe("atomic-agent eval", () => {
  for (const spec of EVAL_CASES) {
    test(`[${spec.category}] ${spec.id}: ${spec.name}`, async () => {
      const result = await runCase(spec, {
        mockHttpUrl: mockHttp ? mockHttp.url : null,
        judge,
      });
      appendReportRow({ spec, result, reportPath: CSV_PATH });
      appendJsonlRow({ spec, result, jsonlPath: JSONL_PATH });

      if (result.skipped) {
        expect(result.skipReason).toBeNull();
        return;
      }

      const failureSummary = formatFailures(result);
      expect(failureSummary, failureSummary ?? "ok").toBeNull();
    });
  }
});

function formatFailures(result: Awaited<ReturnType<typeof runCase>>): string | null {
  const issues: string[] = [];
  if (result.spawn.timedOut) issues.push("spawn timed out");
  if (result.spawn.exitCode !== 0 && result.spawn.exitCode !== null) {
    issues.push(`exit code ${result.spawn.exitCode}`);
  }
  if (result.cli.lastError) issues.push(`agent error: ${result.cli.lastError}`);
  for (const failure of result.failures) {
    issues.push(`${failure.kind}: ${failure.description}`);
  }
  return issues.length === 0 ? null : issues.join("; ");
}
