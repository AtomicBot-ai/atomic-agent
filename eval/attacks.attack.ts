import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadEvalEnvFile } from "./harness/load-env.js";
import { ATTACK_CASES } from "./cases/attacks/index.js";
import { runCase } from "./harness/run-case.js";
import { startMockHttp, type MockHttpHandle } from "./harness/start-mock-http.js";
import { appendJsonlRow } from "./harness/append-jsonl-row.js";
import {
  buildAttackReport,
  formatAttackReport,
  judgeAttack,
  type AttackRow,
} from "./harness/attack-report.js";
import { resolveModelLabel } from "./harness/resolve-model-label.js";

/**
 * Attack suite spec (`npm run eval:attacks`, ATO-623). Runs every case in
 * `ATTACK_CASES` against the model at `ATOMIC_AGENT_EVAL_LLAMA_URL`,
 * gives each a verdict (resisted / fell / error) and writes:
 *
 *   eval/reports/attacks-<ts>.md     the table to read before a release
 *   eval/reports/attacks-<ts>.json   the same, machine-readable
 *   eval/reports/attacks-<ts>.jsonl  full per-case records (reply, tools)
 *   eval/reports/attacks-latest.md   a copy of the newest table
 *
 * A case that did not resist fails its test, so the exit code is
 * non-zero whenever the table has a "fell" or "error" row.
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const STARTED_AT = new Date().toISOString();
const STAMP = STARTED_AT.replace(/[:.]/g, "-");
const REPORTS = resolve(HERE, "reports");
const JSONL_PATH = resolve(REPORTS, `attacks-${STAMP}.jsonl`);

let mockHttp: MockHttpHandle | null = null;
let model = "unknown";
const rows: AttackRow[] = [];

beforeAll(async () => {
  loadEvalEnvFile();
  mockHttp = await startMockHttp();
  model = await resolveModelLabel();
});

afterAll(async () => {
  if (mockHttp) await mockHttp.close();
  mockHttp = null;
  if (rows.length === 0) return;
  const report = buildAttackReport(model, STARTED_AT, rows);
  const markdown = formatAttackReport(report);
  mkdirSync(REPORTS, { recursive: true });
  writeFileSync(resolve(REPORTS, `attacks-${STAMP}.md`), markdown, "utf8");
  writeFileSync(resolve(REPORTS, `attacks-${STAMP}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(resolve(REPORTS, "attacks-latest.md"), markdown, "utf8");
  console.log(`\n${markdown}`);
});

describe("atomic-agent attack suite", () => {
  if (ATTACK_CASES.length === 0) {
    test.skip("no attack cases yet (eval/cases/attacks/index.ts is empty)", () => {});
    return;
  }
  for (const spec of ATTACK_CASES) {
    test(`[attack] ${spec.id}: ${spec.name}`, async () => {
      const handle = mockHttp;
      const result = await runCase(spec, {
        mockHttpUrl: handle ? handle.url : null,
        mockHttpHits: handle ? handle.hits : undefined,
        judge: null,
      });
      appendJsonlRow({ spec, result, jsonlPath: JSONL_PATH });
      const row = judgeAttack(spec, result);
      rows.push(row);
      expect(row.verdict, `${row.verdict}: ${row.detail}`).toBe("resisted");
    });
  }
});
