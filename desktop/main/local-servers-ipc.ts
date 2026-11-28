/**
 * ATO-2489: the route behind "Found running on this computer", in the setup
 * step and in Settings › Local (renderer/local-servers.js).
 *
 *   localServers:detect  {ok, servers} from `atag local-servers --json`: the
 *                        core's detectLocalServers (Ollama on 11434, LM Studio
 *                        on 1234, the Llama app / llama-server on 9931), so the
 *                        app, the terminal and the TUI setup see the same thing.
 *
 * View-only: one GET per server on 127.0.0.1, nothing written. Connecting a
 * found server goes through the paths the app already has (the Ollama / LM
 * Studio presets, the External llama-server address).
 *
 * While the app runs chats on an agent on another computer, the servers that
 * matter are over there, so this answers `remote` and the UI draws nothing.
 * An agent without the command (an older core) answers `unsupported`: hidden too.
 *
 * ATO-2490, acting on them (Settings › Local's Manage panel):
 *
 *   localServers:act     {action, kind, model?, all?, copy?}: runs
 *                        `atag local-servers <action> <kind> [model] --json`
 *                        (start, load, unload, pull, rm, adopt) and answers
 *                        its result line. A pull's steps go to the window as
 *                        `localServers:progress` {action, kind, model, status,
 *                        completed, total}. One action at a time; adopt (it
 *                        writes the custom-models list) under the config lock.
 *                        Adopt only registers the model; the renderer switches
 *                        to it through its own model pick, as Use does.
 *   localServers:cancel  stops the running action (a long download).
 */

import { spawn, type ChildProcess } from "node:child_process";

import { ipcMain, type BrowserWindow } from "electron";

import { resolveBinary } from "./agent-client.js";
import { atagRun, withConfigLock } from "./agent-cli.js";
import {
  actionAnswer,
  actionArgs,
  isUnsupportedCommand,
  parseLocalServers,
  readActionInput,
  readActionLine,
  type LocalServersAnswer,
  type ServerActionInput,
  type ServerActionResult,
} from "./local-servers.js";
import { agentEnv } from "./state-dir.js";

export interface LocalServersIpcDeps {
  isRemote: () => boolean;
  /** ATO-2490: where a download's progress goes. */
  window?: () => BrowserWindow | null;
}

/** The probes take under a second; the rest is the agent binary starting. */
const DETECT_TIMEOUT_MS = 15_000;

export async function detectLocalServersNow(deps: LocalServersIpcDeps): Promise<LocalServersAnswer> {
  if (deps.isRemote()) return { ok: false, remote: true, error: "The app runs chats on another computer." };
  const res = await atagRun(["local-servers", "--json"], DETECT_TIMEOUT_MS).catch(() => null);
  if (!res) return { ok: false, error: "Could not ask the agent." };
  if (!res.ok) {
    return isUnsupportedCommand(res.stderr)
      ? { ok: false, unsupported: true, error: "This agent cannot look for running servers yet." }
      : { ok: false, error: "Could not look for running servers." };
  }
  const servers = parseLocalServers(res.stdout);
  return servers ? { ok: true, servers } : { ok: false, error: "Could not look for running servers." };
}

/** A load can wait minutes for a big model; a download runs as long as it needs (Stop ends it). */
const ACTION_TIMEOUT_MS = 20 * 60_000;

function runAction(binary: string, a: ServerActionInput, deps: LocalServersIpcDeps, hold: (c: ChildProcess | null) => void): Promise<ServerActionResult> {
  const child = spawn(binary, actionArgs(a), { env: agentEnv(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  hold(child);
  let stdout = "";
  let stderr = "";
  let partial = "";
  const timer = a.action === "pull" ? null : setTimeout(() => child.kill(), ACTION_TIMEOUT_MS);
  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stdout += text;
    const lines = (partial + text).split(/\r?\n/);
    partial = lines.pop() ?? "";
    for (const line of lines) {
      const read = readActionLine(line);
      if (read && "progress" in read) {
        deps.window?.()?.webContents.send("localServers:progress", { action: a.action, kind: a.kind, model: a.model, ...read.progress });
      }
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number | null, err?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      hold(null);
      resolve(err ? { ok: false, error: "Could not run the agent.", detail: err.message } : actionAnswer(stdout, stderr, code));
    };
    child.on("close", (code, signal) => finish(signal ? null : code));
    child.on("error", (err) => finish(null, err));
  });
}

export function wireLocalServersIpc(deps: LocalServersIpcDeps): void {
  ipcMain.handle("localServers:detect", () => detectLocalServersNow(deps));

  let running: ChildProcess | null = null;
  let busy = false;
  ipcMain.handle("localServers:act", async (_event, raw: unknown): Promise<ServerActionResult> => {
    if (deps.isRemote()) return { ok: false, error: "The app runs chats on another computer. Manage its model servers there." };
    const input = readActionInput(raw);
    if ("error" in input) return { ok: false, error: input.error };
    if (busy) return { ok: false, error: "Wait for the current action to finish." };
    const binary = resolveBinary();
    if (!binary) return { ok: false, error: "The agent is not installed." };
    busy = true;
    try {
      const go = () => runAction(binary, input, deps, (c) => { running = c; });
      return await (input.action === "adopt" ? withConfigLock(go) : go());
    } finally {
      busy = false;
    }
  });
  ipcMain.handle("localServers:cancel", () => {
    const child = running;
    if (!child) return { ok: false };
    child.kill();
    return { ok: true };
  });
}
