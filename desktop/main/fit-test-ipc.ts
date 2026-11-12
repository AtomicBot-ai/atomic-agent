/**
 * ATO-1091: the routes behind Settings › Models › "Find the best model for
 * my tasks". The agent does the work (PR #1367 / ATO-1090, #1316 / ATO-1089);
 * this only starts it, relays its progress and reads its result
 * (fit-test.ts has the contract).
 *
 *   fitTest:supported  whether this agent has the subcommand (`atag models
 *                      --help` lists it). Never under a remote agent: its
 *                      models are on the other computer.
 *   fitTest:judges     the configured providers that can grade the answers.
 *                      The judge reads the person's tasks, so the window
 *                      makes them pick one; nothing is picked for them.
 *   fitTest:start      {models, judge}: `models tasks collect` into a temp
 *                      file, then `models fit-test … --json` on it. Answers
 *                      {ok, result} at the end, or {ok:false, error | cancelled}.
 *                      Progress goes to the window as `fitTest:progress`.
 *   fitTest:cancel     stops the running one.
 *
 * The test loads other models on the local model server, so main runs it
 * in the daemon's turn, as a llama.cpp update (`inTurn`): no start or switch
 * runs beside it, the supervisor takes its stops as on purpose, and the
 * chats' server is started again after it when it was left down.
 *
 * Cancel: the agent puts the chats' model back in a `finally`, which a
 * signal skips. So after a cancel this file does it: the server the test
 * left running is stopped and the model that was active before is made
 * active again (`models use`), still in the turn; main then starts it.
 * The run's own `atomic-agent run` children go with it: on macOS and Linux
 * the test runs in its own process group, and the whole group is signalled.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { app, ipcMain, type BrowserWindow } from "electron";

import { resolveBinary } from "./agent-client.js";
import { atagRun, configGet, modelsUse, plainCliError, PROVIDER_KEY_ENV } from "./agent-cli.js";
import {
  fitJudgeArgs,
  fitJudges,
  fitModelIds,
  fitResultFromStdout,
  fitTestListed,
  parseFitProgressLine,
  readCollected,
  type FitProgress,
  type FitResult,
} from "./fit-test.js";
import { agentEnv } from "./state-dir.js";

export interface FitTestAnswer {
  ok: boolean;
  result?: FitResult;
  cancelled?: boolean;
  error?: string;
}

export interface FitTestIpcDeps {
  window: () => BrowserWindow | null;
  isRemote: () => boolean;
  /** main.ts: `run` in the daemon's turn, the server held as during an update. */
  inTurn: (run: () => Promise<FitTestAnswer>) => Promise<FitTestAnswer>;
}

interface Running { child: ChildProcess | null; cancelled: boolean }

const NO_TASKS = "There are no recent tasks to test with yet. Chat with the agent for a while, then try again.";

function signal(child: ChildProcess): void {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

export function wireFitTestIpc(deps: FitTestIpcDeps): void {
  // A yes is kept for the session; a no is asked again (the agent may have been updated).
  let supported = false;
  let running: Running | null = null;

  const stop = (run: Running) => {
    run.cancelled = true;
    if (run.child) signal(run.child);
  };
  const tell = (p: FitProgress) => deps.window()?.webContents.send("fitTest:progress", p);

  ipcMain.handle("fitTest:supported", async () => {
    if (deps.isRemote()) return false;
    if (supported) return true;
    const res = await atagRun(["models", "--help"], 15_000).catch(() => null);
    supported = !!res && fitTestListed(res.stdout);
    return supported;
  });

  ipcMain.handle("fitTest:judges", async () => {
    const cfg = await configGet().catch(() => null);
    return cfg && cfg.ok ? fitJudges(cfg.config) : [];
  });

  ipcMain.handle("fitTest:start", async (_event, opts: unknown): Promise<FitTestAnswer> => {
    if (deps.isRemote()) return { ok: false, error: "This app is connected to an agent on another computer: its models are tested there." };
    if (running) return { ok: false, error: "A model test is already running." };
    const binary = resolveBinary();
    if (!binary) return { ok: false, error: "The agent is not installed." };
    const o = opts && typeof opts === "object" ? (opts as { models?: unknown; judge?: unknown }) : {};
    const ids = fitModelIds(o.models);
    if (!ids) return { ok: false, error: "Download at least two local models to compare them." };
    const cfg = await configGet().catch(() => null);
    if (!cfg || !cfg.ok) return { ok: false, error: "Could not read the agent's settings." };
    const judge = fitJudgeArgs(cfg.config, o.judge, (id) => PROVIDER_KEY_ENV[id]);
    if ("error" in judge) return { ok: false, error: judge.error };
    const managed = (cfg.config as { localModels?: { managed?: { modelId?: unknown } } } | undefined)?.localModels?.managed;
    const previous = typeof managed?.modelId === "string" ? managed.modelId : null;

    const run: Running = { child: null, cancelled: false };
    running = run;
    const dir = mkdtempSync(join(tmpdir(), "atag-fit-"));
    try {
      tell({ model: null, modelIndex: null, models: ids.length, task: null, tasks: null, phase: "collecting" });
      const tasksFile = join(dir, "tasks.json");
      const collected = await atagRun(["models", "tasks", "collect", "--out", tasksFile, "--json"], 60_000);
      if (run.cancelled) return { ok: false, cancelled: true };
      const set = readCollected(collected.stdout);
      if (!set) return { ok: false, error: plainCliError(collected.stderr).split("\n").filter((l) => l.trim()).pop() || "Could not collect your recent tasks." };
      if (set.tasks === 0) return { ok: false, error: NO_TASKS };
      const args = ["models", "fit-test", "--tasks", set.path, "--models", ids.join(","), ...judge.args, "--json"];
      return await deps.inTurn(async () => {
        const res = await runFitTest(binary, args, { ...agentEnv(), ...judge.env }, ids, run, tell);
        if (res.cancelled) await putBack(previous);
        return res;
      });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      if (running === run) running = null;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  ipcMain.handle("fitTest:cancel", () => {
    if (running) stop(running);
    return { ok: true };
  });

  // A run the window started does not outlive the app.
  app.on("will-quit", () => { if (running) stop(running); });
}

/** After a cancel: the test's model off the server, the chats' model active again. */
async function putBack(previous: string | null): Promise<void> {
  await atagRun(["models", "stop"], 30_000).catch(() => null);
  if (previous) await modelsUse(previous).catch(() => null);
}

function runFitTest(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  ids: string[],
  run: Running,
  tell: (p: FitProgress) => void,
): Promise<FitTestAnswer> {
  // Cancelled while it waited for its turn.
  if (run.cancelled) return Promise.resolve({ ok: false, cancelled: true });
  const child = spawn(binary, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
  run.child = child;
  let stdout = "";
  let stderr = "";
  let partial = "";
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderr += text;
    const lines = (partial + text).split(/\r?\n/);
    partial = lines.pop() ?? "";
    for (const line of lines) {
      const p = parseFitProgressLine(line, ids);
      if (p) tell(p);
    }
  });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number | null, err?: Error) => {
      if (settled) return;
      settled = true;
      if (run.cancelled) { resolve({ ok: false, cancelled: true }); return; }
      const result = code === 0 && !err ? fitResultFromStdout(stdout) : null;
      if (result) { resolve({ ok: true, result }); return; }
      const said = plainCliError(stderr).split("\n").filter((l) => l.trim() && !parseFitProgressLine(l, ids)).pop();
      resolve({ ok: false, error: err ? err.message : said || `The model test stopped (exit code ${code ?? "none"}) without a result.` });
    };
    child.on("close", (code) => finish(code));
    child.on("error", (err) => finish(null, err));
  });
}
