/**
 * ATO-1091: the routes behind Settings › Models › "Find the best model for
 * my tasks". The agent does the work (`atag models fit-test`, ATO-1090);
 * this only starts it, relays its progress and reads its result
 * (fit-test.ts has the contract).
 *
 *   fitTest:supported  whether this agent has the subcommand (`atag models
 *                      --help` lists it). Never under a remote agent: its
 *                      models are on the other computer.
 *   fitTest:start      runs it; answers {ok, result} at the end, or
 *                      {ok:false, error | cancelled}. Progress goes to the
 *                      window as `fitTest:progress`. One run at a time.
 *   fitTest:cancel     stops the running one (SIGTERM; the agent puts the
 *                      chats' model back).
 *
 * The test loads other models on the local model server, so main runs it
 * in the daemon's turn, as a llama.cpp update (`inTurn`): no start or switch
 * runs beside it, the supervisor takes its stops as on purpose, and the
 * chats' server is started again after it when the agent left it down.
 */

import { spawn, type ChildProcess } from "node:child_process";

import { app, ipcMain, type BrowserWindow } from "electron";

import { resolveBinary } from "./agent-client.js";
import { atagRun, plainCliError } from "./agent-cli.js";
import { fitModelArgs, fitResultFromStdout, fitTestListed, parseFitLine, type FitResult } from "./fit-test.js";
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

export function wireFitTestIpc(deps: FitTestIpcDeps): void {
  // A yes is kept for the session; a no is asked again (the agent may have been updated).
  let supported = false;
  let running: Running | null = null;

  const stop = (run: Running) => {
    run.cancelled = true;
    run.child?.kill("SIGTERM");
  };

  ipcMain.handle("fitTest:supported", async () => {
    if (deps.isRemote()) return false;
    if (supported) return true;
    const res = await atagRun(["models", "--help"], 15_000).catch(() => null);
    supported = !!res && fitTestListed(res.stdout);
    return supported;
  });

  ipcMain.handle("fitTest:start", async (_event, opts: unknown): Promise<FitTestAnswer> => {
    if (deps.isRemote()) return { ok: false, error: "This app is connected to an agent on another computer: its models are tested there." };
    if (running) return { ok: false, error: "A model test is already running." };
    const binary = resolveBinary();
    if (!binary) return { ok: false, error: "The agent is not installed." };
    const ids = opts && typeof opts === "object" ? (opts as { models?: unknown }).models : undefined;
    const args = ["models", "fit-test", "--json", ...fitModelArgs(ids)];
    const run: Running = { child: null, cancelled: false };
    running = run;
    try {
      return await deps.inTurn(() => runFitTest(binary, args, run, deps));
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      if (running === run) running = null;
    }
  });

  ipcMain.handle("fitTest:cancel", () => {
    if (running) stop(running);
    return { ok: true };
  });

  // A run the window started does not outlive the app.
  app.on("will-quit", () => { if (running) stop(running); });
}

function runFitTest(binary: string, args: string[], run: Running, deps: FitTestIpcDeps): Promise<FitTestAnswer> {
  // Cancelled while it waited for its turn.
  if (run.cancelled) return Promise.resolve({ ok: false, cancelled: true });
  const child = spawn(binary, args, { env: agentEnv(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  run.child = child;
  let stdout = "";
  let stderr = "";
  let partial = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stdout += text;
    const lines = (partial + text).split(/\r?\n/);
    partial = lines.pop() ?? "";
    for (const line of lines) {
      const p = parseFitLine(line);
      if (p && p.kind === "progress") deps.window()?.webContents.send("fitTest:progress", p.progress);
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number | null, err?: Error) => {
      if (settled) return;
      settled = true;
      if (run.cancelled) { resolve({ ok: false, cancelled: true }); return; }
      const result = fitResultFromStdout(stdout);
      if (result && !err) { resolve({ ok: true, result }); return; }
      const said = plainCliError(stderr).split("\n").filter((l) => l.trim()).pop();
      resolve({ ok: false, error: err ? err.message : said || `The model test stopped (exit code ${code ?? "none"}) without a result.` });
    };
    child.on("close", (code) => finish(code));
    child.on("error", (err) => finish(null, err));
  });
}
