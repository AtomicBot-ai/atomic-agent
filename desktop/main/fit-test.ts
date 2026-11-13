/**
 * ATO-1091 (desktop half of the model fit-test, epic ATO-994): what the
 * agent's fit-test commands print, read into one shape the models page can
 * draw. Pure: fit-test-ipc.ts runs the commands, this file only reads their
 * text and builds their arguments (test/fit-test.test.mjs).
 *
 * Also how a cancel stops the run (stopFitTest), with the spawn handed in.
 *
 * Aligned with the agent's PR #1367 (ATO-1090) and #1316 (ATO-1089):
 *
 *   `atag models --help` has a `fit-test --tasks <file>` line. No line, no card.
 *
 *   `atag models tasks collect --out <file> --json` writes the last 10 tasks
 *   as a task set and prints {"ok":true,"path","tasks","skipped"}.
 *
 *   `atag models fit-test --tasks <file> --models <a,b[,c]> --judge-url <url>
 *     [--judge-model <id>] [--judge-key-env <NAME>] --json` runs the set on
 *   each model in turn and prints the whole run once, at the end, as one
 *   JSON document (FitTestRun, src/fit-test/fit-test-types.ts):
 *     {kind:"atomic-agent.fit-test-run", version:1, taskIds:[...],
 *      gpuBudgetGb, models:[{modelId, loadError, loadMs, peakMemoryBytes,
 *        tasks:[{taskId, score 1..5|null, reason, durationMs, tokens, timedOut}]}]}
 *   Progress goes to stderr as `<modelId>: task <i>/<n> <name>`.
 *   A task passes at score 4 or more (fit-test-report.ts PASS_SCORE).
 *   The run picks no winner: the window does (fitWinnerId, fit-test.js).
 */

import { stopPlan } from "./platform.js";

export type FitPhase = "collecting" | "loading" | "running" | "judging";

export interface FitProgress {
  model: string | null;
  modelIndex: number | null;
  models: number | null;
  task: number | null;
  tasks: number | null;
  phase: FitPhase | null;
}

export interface FitModelResult {
  id: string;
  name: string | null;
  /** Tasks passed / tasks in the set, 0..1; null when the model did not finish. */
  accuracy: number | null;
  passed: number | null;
  total: number | null;
  /** Mean judge score, 1..5. */
  meanScore: number | null;
  avgSeconds: number | null;
  tokensPerSec: number | null;
  peakMemoryBytes: number | null;
  error: string | null;
}

export interface FitResult {
  tasks: number | null;
  winner: string | null;
  models: FitModelResult[];
}

/** The agent's pass mark (src/fit-test/fit-test-report.ts). */
export const FIT_PASS_SCORE = 4;

/** Whether `atag models --help` names the fit-test subcommand. */
export function fitTestListed(helpText: string): boolean {
  return /^\s*fit-test\b/m.test(String(helpText || ""));
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** One model of a FitTestRun, in the window's shape. */
function readRunModel(raw: unknown, setSize: number | null): FitModelResult | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const id = str(m.modelId);
  if (!id) return null;
  const tasks = Array.isArray(m.tasks) ? m.tasks.filter((t): t is Record<string, unknown> => !!t && typeof t === "object") : [];
  const total = setSize ?? (tasks.length || null);
  const scores = tasks.map((t) => num(t.score)).filter((s): s is number => s !== null);
  const durations = tasks.map((t) => num(t.durationMs)).filter((d): d is number => d !== null && d > 0);
  const loadError = str(m.loadError);
  let error = loadError;
  if (!error && scores.length === 0) {
    const why = tasks.map((t) => str(t.reason)).find((r) => r !== null);
    error = tasks.length ? "no answer could be graded" + (why ? ` (${why})` : "") : "no task ran";
  }
  const passed = scores.filter((s) => s >= FIT_PASS_SCORE).length;
  return {
    id,
    name: null,
    accuracy: error || !total ? null : Math.min(1, passed / total),
    passed: error ? null : passed,
    total,
    meanScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
    avgSeconds: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length / 1000 : null,
    tokensPerSec: null,
    peakMemoryBytes: num(m.peakMemoryBytes),
    error,
  };
}

/** A FitTestRun as the window's result, or null when it carries no model. */
export function readFitRun(raw: unknown): FitResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.kind !== undefined && r.kind !== "atomic-agent.fit-test-run") return null;
  if (!Array.isArray(r.models)) return null;
  const setSize = Array.isArray(r.taskIds) && r.taskIds.length ? r.taskIds.length : null;
  const models = r.models.map((m) => readRunModel(m, setSize)).filter((m): m is FitModelResult => m !== null);
  return models.length ? { tasks: setSize, winner: null, models } : null;
}

/** `--json` prints the whole run as one document at the end. */
export function fitResultFromStdout(stdout: string): FitResult | null {
  const text = String(stdout || "").trim();
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    return readFitRun(JSON.parse(text.slice(start)) as unknown);
  } catch {
    return null;
  }
}

/** One stderr line, `<modelId>: task <i>/<n> <name>`, as progress; null for any other line. */
export function parseFitProgressLine(line: string, modelIds: readonly string[]): FitProgress | null {
  const m = /^(\S+): task (\d+)\/(\d+)(?:\s|$)/.exec(String(line || "").trim());
  if (!m) return null;
  const at = modelIds.indexOf(m[1]!);
  return {
    model: m[1]!,
    modelIndex: at >= 0 ? at + 1 : null,
    models: modelIds.length || null,
    task: Number(m[2]),
    tasks: Number(m[3]),
    phase: "running",
  };
}

/** `models tasks collect --json`'s answer: the set's path and how many tasks it holds. */
export function readCollected(stdout: string): { path: string; tasks: number } | null {
  const line = String(stdout || "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("{")).pop();
  if (!line) return null;
  try {
    const r = JSON.parse(line) as { ok?: unknown; path?: unknown; tasks?: unknown };
    return r.ok === true && typeof r.path === "string" && typeof r.tasks === "number" ? { path: r.path, tasks: r.tasks } : null;
  } catch {
    return null;
  }
}

/** The ids for `--models`: 2 or 3 distinct ids `models use` takes, else null. */
export function fitModelIds(ids: unknown): string[] | null {
  if (!Array.isArray(ids)) return null;
  const clean = [...new Set(ids.filter((id): id is string => typeof id === "string" && /^[\w.-]{1,96}$/.test(id)))];
  return clean.length >= 2 ? clean.slice(0, 3) : null;
}

/* ---------- the judge ---------- */

/** A configured provider the judge can be (an OpenAI-compatible endpoint with a model). */
export interface FitJudge {
  id: string;
  model: string;
  baseUrl: string;
  /** Its endpoint is on this computer (Ollama, LM Studio, a server you run). */
  local: boolean;
}

interface ProviderLike {
  id?: unknown;
  kind?: unknown;
  baseUrl?: unknown;
  defaultChatModel?: unknown;
  model?: unknown;
  apiKey?: unknown;
  apiKeyEnvVar?: unknown;
}

function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

/** The providers in config.json that can grade: OpenAI-compatible, with an address and a model. */
export function fitJudges(config: unknown): FitJudge[] {
  const llm = config && typeof config === "object" ? (config as { llm?: { providers?: unknown } }).llm : undefined;
  const providers = Array.isArray(llm?.providers) ? (llm!.providers as ProviderLike[]) : [];
  const out: FitJudge[] = [];
  for (const p of providers) {
    const id = str(p?.id);
    const baseUrl = str(p?.baseUrl);
    const model = str(p?.defaultChatModel) ?? str(p?.model);
    if (!id || !baseUrl || !model || p.kind !== "openai-compatible") continue;
    out.push({ id, model, baseUrl, local: isLocalUrl(baseUrl) });
  }
  return out;
}

/**
 * The judge flags for provider `id`, and the env the run needs. The key
 * never goes on the command line: an env var the entry names (or the one
 * its preset reads, `keyEnvOf`) is passed by name; a key written in the
 * entry itself goes in the child's env as FIT_JUDGE_API_KEY.
 */
export function fitJudgeArgs(
  config: unknown,
  id: unknown,
  keyEnvOf: (providerId: string) => string | undefined,
): { args: string[]; env: Record<string, string> } | { error: string } {
  const judge = fitJudges(config).find((j) => j.id === id);
  if (!judge) return { error: "Choose who grades the answers." };
  const providers = ((config as { llm: { providers: ProviderLike[] } }).llm.providers);
  const entry = providers.find((p) => str(p?.id) === judge.id)!;
  const args = ["--judge-url", judge.baseUrl, "--judge-model", judge.model];
  const inline = str(entry.apiKey);
  if (inline) return { args: [...args, "--judge-key-env", "FIT_JUDGE_API_KEY"], env: { FIT_JUDGE_API_KEY: inline } };
  const name = str(entry.apiKeyEnvVar) ?? keyEnvOf(judge.id) ?? null;
  return { args: name ? [...args, "--judge-key-env", name] : args, env: {} };
}

/** What stopFitTest needs from node, handed in so the test can watch it. */
export interface FitStopDeps {
  platform: NodeJS.Platform;
  spawn: (command: string, args: string[], opts: { stdio: "ignore"; windowsHide: true; shell: false }) => unknown;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  systemRoot?: string;
}

/**
 * Cancel. The run starts its own `atomic-agent run` children, one per task,
 * and they must go with it. macOS and Linux: the run has its own process
 * group (spawned detached), and the whole group is signalled. Windows has
 * no groups or signals: `taskkill /PID <pid> /T /F` ends the run and its
 * tree, by absolute path, no shell, no window (platform.ts stopPlan, as the
 * agent's own stop does).
 */
export function stopFitTest(child: { pid?: number; kill: (signal?: NodeJS.Signals) => boolean }, deps: FitStopDeps): void {
  const pid = child.pid;
  const plan = pid ? stopPlan(deps.platform, pid, deps.systemRoot) : null;
  try {
    if (plan?.kind === "taskkill") {
      const proc = deps.spawn(plan.command, plan.args, { stdio: "ignore", windowsHide: true, shell: false }) as { on?: (ev: "error", cb: () => void) => unknown };
      // No taskkill to run: the one process at least.
      proc?.on?.("error", () => { try { child.kill("SIGTERM"); } catch { /* gone */ } });
      return;
    }
    if (plan && pid) { deps.kill(-pid, "SIGTERM"); return; }
  } catch {
    /* fall through to the one process */
  }
  try { child.kill("SIGTERM"); } catch { /* gone already */ }
}
