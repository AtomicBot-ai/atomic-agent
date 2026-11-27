#!/usr/bin/env tsx
/**
 * `npm run eval:guard-false-blocks -- --traces <dir> --rules <guard.md> [--limit 100] [--out report.json]`
 *
 * Measures how often plain-text security rules (guard.md, ATO-2111)
 * block ordinary work (ATO-2529). Reads up to `--limit` session traces
 * (`<stateDir>/traces/*.ndjson` of normal sessions, newest first), turns
 * each covered tool call into the request the rules reviewer sees, and
 * asks the reviewer through an OpenAI-compatible endpoint with the same
 * prompt, grammar and verdict parser as the agent. Every block counts as
 * a false block; the target is at most 2% of answered calls.
 *
 * Env: `ATOMIC_AGENT_EVAL_LLAMA_URL` (llama-server base URL, required),
 * `ATOMIC_AGENT_EVAL_GUARD_MODEL` (optional model name). Talks to the
 * model only; runs no tool. Written for the second Mac, not run here.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  buildGuardReviewPrompt,
  extractGuardVerdict,
  GUARD_REVIEW_GBNF,
  GUARD_REVIEW_MAX_TOKENS,
  GUARD_REVIEW_SYSTEM,
} from "../../src/approval/guard-review.js";
import { DEFAULT_GUARD_TOOLS, parseGuardFile, type GuardRuleSet } from "../../src/approval/guard-rules.js";
import { newRiskReviewNonce } from "../../src/approval/risk-review.js";
import type { ApprovalRequest } from "../../src/approval/approval-gate.js";
import { reviewableRequest, summariseFalseBlocks, type ReviewedCall } from "../harness/guard-false-blocks.js";
import { loadEvalEnvFile } from "../harness/load-env.js";
import { collectTraceMetrics } from "../harness/parse-trace-metrics.js";

function flag(name: string, fallback?: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}

function newestTraces(dir: string, limit: number): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ndjson"))
    .map((name) => join(dir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .slice(0, limit);
}

async function review(baseUrl: string, model: string | undefined, request: ApprovalRequest, set: GuardRuleSet) {
  const prompt = buildGuardReviewPrompt({ request, set }, newRiskReviewNonce());
  if (prompt === null) return null;
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      ...(model !== undefined ? { model } : {}),
      messages: [
        { role: "system", content: GUARD_REVIEW_SYSTEM },
        { role: "user", content: prompt },
      ],
      temperature: 0,
      max_tokens: GUARD_REVIEW_MAX_TOKENS,
      grammar: GUARD_REVIEW_GBNF,
    }),
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return extractGuardVerdict({ content: body.choices?.[0]?.message?.content ?? "" });
}

async function main(): Promise<number> {
  loadEvalEnvFile();
  const tracesDir = flag("traces");
  const rulesPath = flag("rules");
  const limit = Number(flag("limit", "100"));
  const baseUrl = process.env.ATOMIC_AGENT_EVAL_LLAMA_URL;
  if (tracesDir === undefined || rulesPath === undefined || baseUrl === undefined || !Number.isFinite(limit)) {
    process.stderr.write("usage: --traces <dir> --rules <guard.md> [--limit 100] [--out file]; needs ATOMIC_AGENT_EVAL_LLAMA_URL\n");
    return 2;
  }
  const file = parseGuardFile(readFileSync(resolve(rulesPath), "utf8"));
  const set: GuardRuleSet = { source: "user", rules: file.rules };
  const tools = new Set(file.tools ?? DEFAULT_GUARD_TOOLS);
  const traces = newestTraces(resolve(tracesDir), limit);
  const calls: ReviewedCall[] = [];
  for (const trace of traces) {
    const metrics = await collectTraceMetrics(trace);
    for (const [index, invocation] of metrics.toolInvocations.entries()) {
      const request = reviewableRequest(invocation, tools, `${trace}#${index}`);
      if (request === null) continue;
      const verdict = await review(baseUrl, process.env.ATOMIC_AGENT_EVAL_GUARD_MODEL, request, set).catch(() => null);
      calls.push({
        trace,
        tool: request.tool,
        preview: request.preview ?? request.reason,
        outcome: verdict === null ? "no-answer" : verdict.decision,
        ...(verdict !== null ? { reason: verdict.reason } : {}),
      });
    }
  }
  const summary = summariseFalseBlocks(traces.length, calls);
  const report = { summary, blocks: calls.filter((c) => c.outcome === "block") };
  const out = flag("out");
  if (out !== undefined) writeFileSync(resolve(out), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `traces ${summary.traces}, reviewed ${summary.reviewed}, blocked ${summary.blocked}, no answer ${summary.noAnswer}, ` +
      `false-block rate ${(summary.falseBlockRate * 100).toFixed(1)}% (target <= ${summary.target * 100}%): ${summary.pass ? "PASS" : "FAIL"}\n`,
  );
  for (const block of report.blocks) process.stdout.write(`  block ${block.tool}: ${block.preview.slice(0, 120)} -> ${block.reason ?? ""}\n`);
  return summary.pass ? 0 : 1;
}

process.exitCode = await main();
