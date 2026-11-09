/**
 * Release exam runner: `npm run eval:exam`.
 *
 * Runs the cases listed in exam-cases.json through the same `runCase` the
 * vitest suite uses, and writes one JSON result that compare-exam.mjs can
 * diff against the previous release. See eval/exam/README.md.
 *
 * This is a plain script rather than a vitest spec because it needs
 * per-case error handling (a setup error is "not run", never a failure)
 * and repeated rounds, and because it must never join `npm run eval`.
 *
 * Exit codes: 0 every case ran, 2 the exam could not start or at least one
 * case did not run. A failed case does not change the exit code: judging
 * the result is the job of the compare step.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EVAL_CASES } from "../cases/index.js";
import type { EvalCase } from "../harness/case-schema.js";
import { loadEvalEnvFile } from "../harness/load-env.js";
import { runCase, type RunCaseResult } from "../harness/run-case.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const DEFAULT_OUT_DIR = resolve(HERE, "..", "reports", "exam");
const DEFAULT_CASE_TIMEOUT_MS = 300_000;

type AttemptStatus = "passed" | "failed" | "not_run";

interface ManifestEntry {
  id: string;
  category: string;
  why: string;
}

interface Attempt {
  status: AttemptStatus;
  durationMs: number | null;
  steps: number | null;
  promptTokens: number | null;
  predictedTokens: number | null;
  notRunReason: string | null;
  failReasons: string[];
}

interface CaseRecord {
  id: string;
  category: string;
  digest: string;
  attempts: Attempt[];
}

/** Stops the exam before any case runs, with a message for the operator. */
class ExamCannotStart extends Error {}

function parseArgs(argv: string[]): { repeat: number; outDir: string } {
  let repeat = 1;
  let outDir = DEFAULT_OUT_DIR;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--repeat" && value !== undefined) {
      repeat = Number(value);
      if (!Number.isInteger(repeat) || repeat < 1) {
        throw new ExamCannotStart(`--repeat expects a whole number of 1 or more, got ${value}`);
      }
      index += 1;
    } else if (flag === "--out-dir" && value !== undefined) {
      outDir = resolve(value);
      index += 1;
    } else {
      throw new ExamCannotStart(
        `unknown or incomplete argument: ${flag}. Usage: npm run eval:exam -- [--repeat N] [--out-dir DIR]`,
      );
    }
  }
  return { repeat, outDir };
}

function loadManifest(): ManifestEntry[] {
  const raw = readFileSync(join(HERE, "exam-cases.json"), "utf8");
  return (JSON.parse(raw) as { cases: ManifestEntry[] }).cases;
}

/** Resolves manifest ids to cases, refusing anything the exam must not contain. */
function selectCases(manifest: ManifestEntry[]): EvalCase[] {
  const byId = new Map(EVAL_CASES.map((spec) => [spec.id, spec]));
  const seen = new Set<string>();
  return manifest.map((entry) => {
    const spec = byId.get(entry.id);
    if (!spec) throw new ExamCannotStart(`manifest names an unknown case: ${entry.id}`);
    if (seen.has(entry.id)) throw new ExamCannotStart(`manifest lists a case twice: ${entry.id}`);
    seen.add(entry.id);
    if (spec.requires && spec.requires.length > 0) {
      throw new ExamCannotStart(`${entry.id} needs ${spec.requires.join(", ")}, which the exam does not start`);
    }
    if (spec.expectations.some((expectation) => expectation.kind === "judge")) {
      throw new ExamCannotStart(`${entry.id} needs a judge model, which the exam does not use`);
    }
    return spec;
  });
}

/**
 * Fingerprint of what the case asks and checks, so editing a case between
 * two releases reads as a different exam. `setup` is left out because its
 * compiled text can change with the toolchain alone.
 */
function caseDigest(spec: EvalCase): string {
  const payload = JSON.stringify(
    { prompt: spec.prompt, maxSteps: spec.maxSteps ?? null, expectations: spec.expectations },
    (_key: string, value: unknown) => (value instanceof RegExp ? value.toString() : value),
  );
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

function newestMtimeMs(dir: string, include: (path: string) => boolean): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    if (!include(entry)) continue;
    const stats = statSync(join(dir, entry));
    if (stats.isFile()) newest = Math.max(newest, stats.mtimeMs);
  }
  return newest;
}

/**
 * The harness silently prefers dist/ when it exists, so an old build would
 * be graded under the new commit's name.
 */
function assertBuildIsCurrent(): void {
  const distDir = join(REPO_ROOT, "dist");
  if (!existsSync(join(distDir, "cli", "index.js"))) {
    throw new ExamCannotStart("dist/cli/index.js is missing. Run `npm run build` first.");
  }
  const newestSource = newestMtimeMs(
    join(REPO_ROOT, "src"),
    (path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path),
  );
  const newestBuild = newestMtimeMs(distDir, (path) => path.endsWith(".js"));
  if (newestSource > newestBuild) {
    throw new ExamCannotStart(
      "dist/ is older than src/, so the exam would grade a stale agent. Run `npm run build` first.",
    );
  }
}

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function serverHeaders(): Record<string, string> {
  const key = process.env.ATOMIC_AGENT_LLAMA_API_KEY;
  return key ? { authorization: `Bearer ${key}` } : {};
}

async function serverAnswers(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(10_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function fetchServerJson(url: string): Promise<Record<string, unknown> | null> {
  const response = await fetch(url, {
    headers: serverHeaders(),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 401 || response.status === 403) {
    throw new ExamCannotStart(
      "the model server rejected the request (it needs an API key). Use a plain llama-server, or set ATOMIC_AGENT_LLAMA_API_KEY.",
    );
  }
  return response.ok ? ((await response.json()) as Record<string, unknown>) : null;
}

/** The name of the GGUF the server has loaded, which is what the agent will talk to. */
async function readModelName(url: string): Promise<string> {
  const props = await fetchServerJson(`${url}/props`);
  for (const candidate of [props?.model_path, props?.model_alias]) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return basename(candidate.replaceAll("\\", "/"));
    }
  }
  const models = await fetchServerJson(`${url}/v1/models`);
  const first = Array.isArray(models?.data) ? (models.data[0] as { id?: unknown } | undefined) : undefined;
  if (typeof first?.id === "string" && first.id.length > 0) return basename(first.id);
  throw new ExamCannotStart(
    `could not read a model name from ${url}. Without it two exams cannot be compared.`,
  );
}

function lastLine(text: string): string {
  return text.trim().split(/\r?\n/).pop()?.slice(0, 300) ?? "";
}

/** Why this run says nothing about the agent, or null when it can be graded. */
async function findNotRunReason(result: RunCaseResult, url: string): Promise<string | null> {
  if (result.skipped) return result.skipReason ?? "skipped by the harness";
  if (!result.spawn.timedOut && result.cli.sessionId === null) {
    return `agent exited without a session (exit code ${result.spawn.exitCode}): ${lastLine(result.spawn.stderr)}`;
  }
  // Without a trace every tool and step check would be graded on nothing.
  if (result.cli.sessionId !== null && !result.metrics.found) {
    return "the session trace is missing, so the case cannot be graded";
  }
  if (result.passed) return null;
  if (!(await serverAnswers(url))) return "the model server stopped answering";
  if (result.metrics.found && result.metrics.totalPredictedTokens === 0) {
    const detail = result.metrics.failureMessage ?? result.cli.lastError ?? "no error recorded";
    return `the model produced no output: ${detail}`;
  }
  return null;
}

function failReasons(result: RunCaseResult): string[] {
  const reasons = result.failures.map((failure) => failure.description);
  if (result.spawn.timedOut) reasons.unshift("timed out");
  else if (result.spawn.exitCode !== 0) reasons.unshift(`exit code ${result.spawn.exitCode}`);
  return reasons;
}

function notRunAttempt(reason: string): Attempt {
  return {
    status: "not_run",
    durationMs: null,
    steps: null,
    promptTokens: null,
    predictedTokens: null,
    notRunReason: reason,
    failReasons: [],
  };
}

async function runAttempt(spec: EvalCase, url: string, timeoutMs: number): Promise<Attempt> {
  let result: RunCaseResult;
  try {
    result = await runCase(spec, { mockHttpUrl: null, judge: null, timeoutMs });
  } catch (err) {
    return notRunAttempt(`setup or launch error: ${err instanceof Error ? err.message : String(err)}`);
  }
  const reason = await findNotRunReason(result, url);
  if (reason !== null) return notRunAttempt(reason);
  // A run killed by the timeout has no session id, so no trace to read.
  const metrics = result.metrics.found ? result.metrics : null;
  return {
    status: result.passed ? "passed" : "failed",
    durationMs: result.spawn.durationMs,
    steps: metrics?.stepCount ?? null,
    promptTokens: metrics?.totalPromptTokens ?? null,
    predictedTokens: metrics?.totalPredictedTokens ?? null,
    notRunReason: null,
    failReasons: failReasons(result),
  };
}

function median(values: Array<number | null>): number | null {
  const sorted = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const upper = sorted[Math.floor(sorted.length / 2)] as number;
  if (sorted.length % 2 === 1) return upper;
  return (upper + (sorted[sorted.length / 2 - 1] as number)) / 2;
}

/**
 * One verdict per case. A strict majority of the attempts that ran decides,
 * so a tie is a fail. If at most half of the attempts ran there is no
 * majority to speak of, and the case counts as not run.
 */
function summariseCase(record: CaseRecord): Record<string, unknown> {
  const ran = record.attempts.filter((attempt) => attempt.status !== "not_run");
  const passVotes = ran.filter((attempt) => attempt.status === "passed").length;
  let status: AttemptStatus = "failed";
  if (ran.length * 2 <= record.attempts.length) status = "not_run";
  else if (passVotes * 2 > ran.length) status = "passed";
  const promptTokens = median(ran.map((attempt) => attempt.promptTokens));
  const predictedTokens = median(ran.map((attempt) => attempt.predictedTokens));
  return {
    id: record.id,
    category: record.category,
    digest: record.digest,
    status,
    passVotes,
    attemptsRun: ran.length,
    durationMs: median(ran.map((attempt) => attempt.durationMs)),
    steps: median(ran.map((attempt) => attempt.steps)),
    promptTokens,
    predictedTokens,
    tokens: promptTokens === null || predictedTokens === null ? null : promptTokens + predictedTokens,
    notRunReason:
      status === "not_run"
        ? (record.attempts.find((attempt) => attempt.notRunReason !== null)?.notRunReason ?? null)
        : null,
    failReasons: status === "failed" ? ran.flatMap((attempt) => attempt.failReasons) : [],
    attempts: record.attempts,
  };
}

function describeAttempt(attempt: Attempt): string {
  if (attempt.status === "not_run") return `NOT RUN  ${attempt.notRunReason}`;
  const seconds = ((attempt.durationMs ?? 0) / 1000).toFixed(1);
  const head = `${attempt.status === "passed" ? "PASS" : "FAIL"}  ${seconds}s  ${attempt.steps ?? "?"} steps`;
  return attempt.status === "failed" ? `${head}  ${attempt.failReasons.join("; ")}` : head;
}

async function main(): Promise<number> {
  const { repeat, outDir } = parseArgs(process.argv.slice(2));
  loadEvalEnvFile();
  // Exam sessions are not real usage and must stay out of product analytics.
  process.env.DO_NOT_TRACK ??= "1";

  const url = process.env.ATOMIC_AGENT_EVAL_LLAMA_URL?.replace(/\/+$/, "");
  if (!url) {
    throw new ExamCannotStart(
      "ATOMIC_AGENT_EVAL_LLAMA_URL is not set. Point it at a running llama-server (shell or eval/.env).",
    );
  }
  const manifest = loadManifest();
  const specs = selectCases(manifest);
  assertBuildIsCurrent();
  if (!(await serverAnswers(url))) {
    throw new ExamCannotStart(`no healthy model server at ${url}. Start llama-server first.`);
  }
  const model = await readModelName(url);

  const timeoutFromEnv = Number.parseInt(process.env.ATOMIC_AGENT_EVAL_TIMEOUT_MS ?? "", 10);
  const timeoutMs = timeoutFromEnv > 0 ? timeoutFromEnv : DEFAULT_CASE_TIMEOUT_MS;
  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version: string };
  const gitCommit = git(["rev-parse", "HEAD"]) ?? "unknown";
  const gitDirty = (git(["status", "--porcelain"]) ?? "") !== "";
  const date = new Date().toISOString();

  mkdirSync(outDir, { recursive: true });
  const stamp = date.replace(/[:.]/g, "-");
  const outPath = join(outDir, `exam-${packageJson.version}-${gitCommit.slice(0, 8)}-${stamp}.json`);

  const records: CaseRecord[] = specs.map((spec, index) => ({
    id: spec.id,
    category: manifest[index]?.category ?? "",
    digest: caseDigest(spec),
    attempts: [],
  }));

  // Written after every attempt so a crash still leaves evidence. The
  // compare step refuses a file whose `complete` flag is false.
  const save = (complete: boolean): Array<Record<string, unknown>> => {
    const cases = records.map(summariseCase);
    const count = (status: AttemptStatus): number => cases.filter((entry) => entry.status === status).length;
    const report = {
      schema: 1,
      complete,
      agentVersion: packageJson.version,
      gitCommit,
      gitDirty,
      model,
      date,
      repeat,
      timeoutMs,
      summary: {
        total: cases.length,
        passed: count("passed"),
        failed: count("failed"),
        notRun: count("not_run"),
      },
      cases,
    };
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return cases;
  };

  console.log(`Exam: ${specs.length} cases x ${repeat} on ${model}, agent ${packageJson.version} (${gitCommit.slice(0, 8)})`);
  if (gitDirty) console.log("Note: the working tree has uncommitted changes, so the commit does not fully describe this run.");

  for (let round = 1; round <= repeat; round += 1) {
    for (const [index, spec] of specs.entries()) {
      const record = records[index];
      if (!record) continue;
      const attempt = await runAttempt(spec, url, timeoutMs);
      record.attempts.push(attempt);
      save(false);
      console.log(`[round ${round}/${repeat}, ${index + 1}/${specs.length}] ${spec.id}: ${describeAttempt(attempt)}`);
    }
  }

  const cases = save(true);
  const notRun = cases.filter((entry) => entry.status === "not_run");
  const passed = cases.filter((entry) => entry.status === "passed").length;
  const graded = cases.length - notRun.length;
  console.log(`\nResult: ${passed} of ${graded} graded cases passed.`);
  console.log(`Saved to ${outPath}`);
  if (notRun.length === 0) return 0;
  console.log(`\n${notRun.length} case(s) DID NOT RUN and say nothing about the agent:`);
  for (const entry of notRun) console.log(`  ${String(entry.id)}: ${String(entry.notRunReason)}`);
  return 2;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    if (err instanceof ExamCannotStart) console.error(`Exam did not start: ${err.message}`);
    else console.error(err);
    process.exit(2);
  });
