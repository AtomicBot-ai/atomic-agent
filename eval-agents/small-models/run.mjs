#!/usr/bin/env node
// Small-model bench runner (ATO-1118). See RUNBOOK.md before running anything:
// a real run loads a local model and needs Nadya's explicit "yes".
//
//   node eval-agents/small-models/run.mjs --dry-run --profile release --agent <checkout>
//   node eval-agents/small-models/run.mjs --agent <checkout> --server-url http://127.0.0.1:18190 --models qwen3.5-4b
//   node eval-agents/small-models/run.mjs --agent <checkout> --start-server --models-dir <dir> --profile release
//   node eval-agents/small-models/run.mjs fixture <task> <empty dir> [--window 32768]
//   node eval-agents/small-models/run.mjs --list

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { agentEnv, buildAgentConfig, resolveAgentCommand, runAgent, seedStateDir } from "./lib/agent.mjs";
import { foldTrace, readTraceDir } from "./lib/trace.mjs";
import { TASKS, getTask, selectTasks } from "./tasks/index.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

export function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      opts._.push(a);
      continue;
    }
    const [k, inline] = a.slice(2).split("=", 2);
    const flags = new Set(["dry-run", "start-server", "list", "help"]);
    if (flags.has(k)) opts[k] = true;
    else opts[k] = inline ?? argv[(i += 1)];
  }
  return opts;
}

const list = (v) => (v === undefined ? undefined : String(v).split(",").map((s) => s.trim()).filter(Boolean));

/** Resolve CLI flags + matrix.json + profile into a concrete plan. Pure; used by --dry-run and tests. */
export function buildPlan(opts, matrix) {
  const profile = opts.profile ? matrix.profiles?.[opts.profile] : undefined;
  if (opts.profile && !profile) throw new Error(`unknown profile '${opts.profile}'`);
  const pickModels = (spec) => {
    if (spec === undefined || spec === "default") return matrix.models.filter((m) => m.default);
    const ids = Array.isArray(spec) ? spec : list(spec);
    return ids.map((id) => {
      const m = matrix.models.find((x) => x.id === id);
      if (!m) throw new Error(`unknown model '${id}' (matrix.json: ${matrix.models.map((x) => x.id).join(", ")})`);
      return m;
    });
  };
  const models = pickModels(list(opts.models) ?? profile?.models);
  const windows = (list(opts.windows) ?? profile?.windows ?? matrix.windows).map(Number);
  const thinking = list(opts.thinking) ?? profile?.thinking ?? matrix.thinking;
  const tasks = selectTasks(opts.tasks ?? profile?.tasks ?? "all");
  const repeats = Number(opts.repeats ?? profile?.repeats ?? matrix.repeats);
  if (opts["server-url"] && (models.length !== 1 || windows.length !== 1)) {
    throw new Error("--server-url serves one model at one window: pass exactly one --models and one --windows (or start servers with --start-server)");
  }
  const cells = [];
  for (const model of models) {
    for (const window of windows) {
      cells.push({ model, window, thinking, server: serverCommand(matrix.server, model, window, opts["models-dir"]) });
    }
  }
  const runs = cells.length * thinking.length * tasks.length * repeats;
  const worstSec = cells.length * thinking.length * repeats * tasks.reduce((s, t) => s + t.timeoutSec, 0);
  return { cells, tasks, repeats, runs, worstSec };
}

export function serverCommand(server, model, window, modelsDir = "<models-dir>") {
  const fill = (s) =>
    s
      .replace("{gguf}", join(modelsDir, model.gguf))
      .replace("{alias}", model.alias ?? model.id)
      .replace("{host}", server.host)
      .replace("{port}", String(server.port))
      .replace("{window}", String(window));
  return { bin: server.bin, args: server.args.map(fill), url: `http://${server.host}:${server.port}` };
}

function printPlan(plan, opts) {
  const out = [];
  out.push(`small-model bench plan${opts["dry-run"] ? " (dry run: nothing will start)" : ""}`);
  out.push(`agent: ${opts.agent ?? "<--agent not set>"}`);
  out.push(`tasks (${plan.tasks.length}): ${plan.tasks.map((t) => `${t.id}[${t.set},${t.timeoutSec}s]`).join(" ")}`);
  out.push(`repeats: ${plan.repeats}`);
  for (const c of plan.cells) {
    out.push(``, `cell: ${c.model.label} @ ${c.window} tokens, thinking ${c.thinking.join("/")}`);
    if (opts["server-url"]) out.push(`  server: use existing ${opts["server-url"]}`);
    else out.push(`  server: ${c.server.bin} ${c.server.args.join(" ")}`);
  }
  out.push(``, `agent config seeded per run (fresh state dir, never ~/.atomic-agent; thinking set per cell):`);
  out.push(`  ${JSON.stringify(buildAgentConfig({ serverUrl: "<server-url>", thinking: "off", maxSteps: "<task.maxSteps>" }))}`);
  out.push(``, `runs: ${plan.runs}; worst case (every run hits its timeout): ${(plan.worstSec / 3600).toFixed(1)} h`);
  out.push(`typical guess (runs end at ~20% of the timeout; not measured yet): ${((plan.worstSec * 0.2) / 3600).toFixed(1)} h`);
  return out.join("\n");
}

async function waitHealthy(url, timeoutSec) {
  const until = Date.now() + timeoutSec * 1000;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function serverWindow(url) {
  try {
    const r = await fetch(`${url}/props`);
    const j = await r.json();
    return j?.default_generation_settings?.n_ctx ?? j?.n_ctx ?? null;
  } catch {
    return null;
  }
}

function gitSha(root) {
  if (!root) return null;
  const r = spawnSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

async function startServer(cmd, logPath, healthSec) {
  const log = [];
  const child = spawn(cmd.bin, cmd.args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
  const sink = (b) => appendFileSync(logPath, b);
  child.stdout.on("data", sink);
  child.stderr.on("data", sink);
  child.on("error", (e) => log.push(String(e)));
  const ok = await waitHealthy(cmd.url, healthSec);
  const stop = () => {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* gone */
    }
  };
  if (!ok) {
    stop();
    throw new Error(`llama-server did not come up in ${healthSec}s, see ${logPath} ${log.join(" ")}`);
  }
  return stop;
}

/** One task run: fresh temp workspace + fresh state dir -> agent -> checker -> row. */
export async function runOne({ task, cell, thinking, repeat, serverUrl, command, outDir, keep, matrix, runId, agentSha }) {
  const rel = join(cell.model.id, String(cell.window), `thinking-${thinking}`, `${task.id}-r${repeat}`);
  const runDir = join(outDir, "runs", rel);
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), "aa-small-bench-"));
  const workDir = join(scratch, "work");
  const stateDir = join(scratch, "state");
  mkdirSync(workDir);
  const ctx = { window: cell.window };
  const meta = task.fixture(workDir, ctx);
  writeFileSync(join(runDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  seedStateDir(stateDir, buildAgentConfig({ serverUrl, thinking, maxSteps: task.maxSteps, overrides: matrix.agent?.configOverrides ?? {} }));
  const turns = task.turns(ctx);
  const started = new Date();
  let res;
  try {
    res = await runAgent({
      command,
      workDir,
      stateDir,
      turns,
      maxSteps: task.maxSteps,
      timeoutMs: task.timeoutSec * 1000,
      env: agentEnv(stateDir, matrix.agent?.env ?? {}),
    });
  } catch (err) {
    res = { exitCode: null, timedOut: false, durationMs: 0, stdout: "", stderr: String(err), turnsSent: 0, replies: 0, spawnError: true };
  }
  writeFileSync(join(runDir, "agent.stdout.log"), res.stdout);
  writeFileSync(join(runDir, "agent.stderr.log"), res.stderr);
  const traceRead = readTraceDir(stateDir);
  if (traceRead.files.length) {
    mkdirSync(join(runDir, "traces"), { recursive: true });
    for (const f of traceRead.files) cpSync(f, join(runDir, "traces", f.split("/").pop()));
  }
  const trace = foldTrace(traceRead.text);
  let verdict;
  if (res.spawnError) verdict = { pass: false, reason: `agent did not start: ${res.stderr.slice(0, 80)}` };
  else if (res.timedOut) verdict = { pass: false, reason: `timeout ${task.timeoutSec}s` };
  else {
    try {
      verdict = task.check(workDir, meta, { ...ctx, trace, run: { turnsSent: res.turnsSent, replies: res.replies, totalTurns: turns.length } });
    } catch (err) {
      verdict = { pass: false, reason: `checker crashed: ${String(err).slice(0, 80)}` };
    }
  }
  const row = {
    runId,
    ts: started.toISOString(),
    agentSha,
    model: cell.model.id,
    size: cell.model.size,
    window: cell.window,
    thinking,
    task: task.id,
    set: task.set,
    repeat,
    pass: verdict.pass,
    reason: verdict.reason ?? "",
    details: verdict.details ?? null,
    seconds: Math.round(res.durationMs / 1000),
    exitCode: res.exitCode,
    timedOut: res.timedOut,
    turns: turns.length,
    turnsSent: res.turnsSent,
    steps: trace.steps,
    promptTokens: trace.promptTokens,
    maxPromptTokens: trace.maxPromptTokens,
    predictedTokens: trace.predictedTokens,
    toolCalls: trace.toolCalls.length,
    toolErrors: trace.toolErrors,
    compactions: trace.compactions,
    compactionFailures: trace.compactionFailures,
    parseRetries: trace.parseRetries,
    loopDetected: trace.loopDetected,
    lastError: trace.lastError,
    dir: rel,
  };
  writeFileSync(join(runDir, "result.json"), `${JSON.stringify(row, null, 2)}\n`);
  if (keep === "all" || (keep === "fail" && !row.pass)) cpSync(workDir, join(runDir, "workspace"), { recursive: true });
  rmSync(scratch, { recursive: true, force: true });
  return row;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 11).join("\n").replace(/^\/\/ ?/gm, "") + "\n");
    return 0;
  }
  if (opts.list) {
    for (const t of TASKS) process.stdout.write(`${t.id.padEnd(6)} ${t.set.padEnd(7)} ${String(t.timeoutSec).padStart(5)}s  ${t.title}\n`);
    return 0;
  }
  if (opts._[0] === "fixture") {
    const [, id, dir] = opts._;
    if (!id || !dir) throw new Error("usage: run.mjs fixture <task> <empty dir> [--window N]");
    mkdirSync(dir, { recursive: true });
    if (readdirSync(dir).length) throw new Error(`${dir} is not empty`);
    const meta = getTask(id).fixture(resolve(dir), { window: Number(opts.window ?? 32768) });
    process.stdout.write(`${JSON.stringify(meta, (k, v) => (typeof v === "string" && v.length > 200 ? `${v.slice(0, 200)}…` : v), 2)}\n`);
    return 0;
  }

  const matrix = JSON.parse(readFileSync(opts.matrix ?? join(HERE, "matrix.json"), "utf8"));
  const plan = buildPlan(opts, matrix);
  process.stdout.write(`${printPlan(plan, opts)}\n`);
  if (opts["dry-run"]) return 0;

  const command = resolveAgentCommand(opts.agent);
  if (!opts["server-url"] && !opts["start-server"]) throw new Error("pass --server-url <url> (existing llama-server) or --start-server --models-dir <dir>");
  if (opts["start-server"] && !opts["models-dir"]) throw new Error("--start-server needs --models-dir <folder with the GGUF files>");
  if (opts["llama-server"]) matrix.server.bin = opts["llama-server"];

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  // Default output lives under eval-agents/reports/ (gitignored): `mbp` only syncs tracked
  // files and overlays the checkout, so results must not sit in a tracked path.
  const outDir = resolve(opts.out ?? join(REPO_ROOT, "eval-agents", "reports", "small-models", runId));
  mkdirSync(outDir, { recursive: true });
  const resultsPath = join(outDir, "results.jsonl");
  const agentSha = gitSha(command.root);
  writeFileSync(
    join(outDir, "environment.json"),
    `${JSON.stringify({ runId, agent: { kind: command.label, sha: agentSha }, node: process.version, platform: `${process.platform}-${process.arch}`, plan: { cells: plan.cells.map((c) => ({ model: c.model.id, window: c.window, thinking: c.thinking })), tasks: plan.tasks.map((t) => t.id), repeats: plan.repeats }, server: matrix.server }, null, 2)}\n`,
  );
  const keep = opts.keep ?? "fail";

  for (const cell of plan.cells) {
    let stop = () => {};
    const serverUrl = opts["server-url"] ?? cell.server.url;
    if (opts["start-server"]) {
      if (!existsSync(cell.server.args[cell.server.args.indexOf("-m") + 1])) throw new Error(`GGUF not found for ${cell.model.id}`);
      if (await waitHealthy(cell.server.url, 1)) throw new Error(`something already listens on ${cell.server.url}; stop it or use --server-url`);
      stop = await startServer(cell.server, join(outDir, `llama-server-${cell.model.id}-${cell.window}.log`), matrix.server.healthTimeoutSec ?? 300);
    } else if (!(await waitHealthy(serverUrl, 5))) {
      throw new Error(`llama-server at ${serverUrl} is not healthy`);
    }
    try {
      const nCtx = await serverWindow(serverUrl);
      if (nCtx !== null && nCtx !== cell.window) {
        throw new Error(`server window is ${nCtx}, cell expects ${cell.window}: restart llama-server with -c ${cell.window}`);
      }
      for (const thinking of cell.thinking) {
        for (const task of plan.tasks) {
          for (let r = 1; r <= plan.repeats; r += 1) {
            process.stdout.write(`== ${cell.model.id} ${cell.window} thinking-${thinking} ${task.id} r${r} ... `);
            const row = await runOne({ task, cell, thinking, repeat: r, serverUrl, command, outDir, keep, matrix, runId, agentSha });
            appendFileSync(resultsPath, `${JSON.stringify(row)}\n`);
            process.stdout.write(`${row.pass ? "PASS" : "FAIL"} ${row.seconds}s ${row.reason}\n`);
          }
        }
      }
    } finally {
      stop();
    }
  }
  process.stdout.write(`\nresults: ${resultsPath}\nsummary: node eval-agents/small-models/summary.mjs ${resultsPath} --gate\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`small-model bench: ${err.message}\n`);
      process.exit(2);
    },
  );
}
