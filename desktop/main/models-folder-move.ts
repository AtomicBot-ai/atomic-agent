/**
 * ATO-2503: running one models folder move (`atag models dir ...`) for
 * Settings › Models › "Models folder" (models-folder-ipc.ts wires it).
 *
 * The move runs in the daemon's turn (backend-switch inDaemonTurn) and under
 * the config lock, as the llama.cpp update does, so no Start, launch start or
 * supervisor restart begins while models are copied; the agent's own marker
 * refuses any that would.
 *
 * Cancel is cooperative: the agent runs with `--stop-on-stdin` and gets a
 * "stop" line, then rolls every model back as on Ctrl+C. A signal cannot do
 * that on Windows, where SIGTERM ends the process at once. Off Windows a
 * SIGTERM goes too (an older agent without the flag still rolls back on it).
 * Only when the agent has not ended MOVE_KILL_GRACE_MS later is it killed,
 * and the answer then says what may be left in the new folder. A move quiet
 * for MOVE_QUIET_LIMIT_MS is stopped the same way, so a disk that stops
 * answering cannot hold the config lock and the daemon's turn for ever.
 *
 * A Cancel that comes before the move has begun (the move waits for the
 * daemon's turn behind a launch start or a fit-test) is kept and the move
 * then ends without spawning anything.
 */

import { spawn } from "node:child_process";

import { plainCliError, withConfigLock } from "./agent-cli.js";
import { inDaemonTurn } from "./backend-switch.js";
import {
  leftoversFromStdout,
  movedToFromStdout,
  MOVE_HUNG_WORDS,
  MOVE_KILL_GRACE_MS,
  MOVE_QUIET_LIMIT_MS,
  moveErrorDetail,
  moveErrorWords,
  parseModelsMoveBytes,
  parseModelsMoveLine,
  type ModelsMoveProgress,
} from "./models-folder.js";
import { agentEnv } from "./state-dir.js";

export interface ModelsFolderMoveAnswer {
  ok: boolean;
  dir?: string;
  leftovers?: string[];
  error?: string;
  /** ATO-2742: the agent's raw text, shown only behind Details. */
  detail?: string;
}

/** What the window hears while a move runs: the model, and bytes across disks. */
export type ModelsFolderProgress = ModelsMoveProgress & { done?: number; size?: number };

/** The part of a child process a move uses; a test hands in a fake. */
export interface MoveChild {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  stdin: NodeJS.WritableStream | null;
  exitCode: number | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "close", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}

export interface RunMoveOptions {
  send?: (p: ModelsFolderProgress) => void;
  /** Hands out the stop for Cancel. */
  onStop?: (stop: () => void) => void;
  spawnChild?: (binary: string, args: string[]) => MoveChild;
  platform?: NodeJS.Platform;
  quietMs?: number;
  graceMs?: number;
}

/** The flag that makes the agent stop on a "stop" line (src/cli/models-dir-command.ts). */
export const STOP_ON_STDIN_FLAG = "--stop-on-stdin";

export const MOVE_FORCED_WORDS =
  "The move was stopped before the agent could tidy up. Your models are still in the old folder, " +
  "but models already copied may be left in the new one: delete them there before you use that folder.";

export const MOVE_CANCELLED_BEFORE_START_WORDS = "The move was stopped before it began. Your models did not move.";

function defaultSpawn(binary: string, args: string[]): MoveChild {
  return spawn(binary, args, { env: agentEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true }) as unknown as MoveChild;
}

/** Run `atag models dir ... --stop-on-stdin` and answer how it went. */
export function runMove(binary: string, args: string[], opts: RunMoveOptions = {}): Promise<ModelsFolderMoveAnswer> {
  const quietMs = opts.quietMs ?? MOVE_QUIET_LIMIT_MS;
  const graceMs = opts.graceMs ?? MOVE_KILL_GRACE_MS;
  const platform = opts.platform ?? process.platform;
  const send = opts.send ?? (() => {});
  const child = (opts.spawnChild ?? defaultSpawn)(binary, [...args, STOP_ON_STDIN_FLAG]);
  let stdout = "";
  let stderr = "";
  let partial = "";
  let last: ModelsMoveProgress | null = null;
  let hung = false;
  let stopping = false;
  let forced = false;
  let quiet: NodeJS.Timeout | null = null;
  let kill: NodeJS.Timeout | null = null;
  // A stdin closed under us (the agent ended) must not crash the app.
  child.stdin?.on("error", () => {});
  const stop = () => {
    if (stopping || child.exitCode !== null) return;
    stopping = true;
    try {
      child.stdin?.write("stop\n");
      child.stdin?.end();
    } catch {
      /* the agent is ending already */
    }
    if (platform !== "win32") child.kill("SIGTERM");
    kill = setTimeout(() => {
      if (child.exitCode === null) {
        forced = true;
        child.kill("SIGKILL");
      }
    }, graceMs);
    kill.unref?.();
  };
  const heard = () => {
    if (quiet) clearTimeout(quiet);
    quiet = setTimeout(() => { hung = true; stop(); }, quietMs);
    quiet.unref?.();
  };
  opts.onStop?.(stop);
  heard();
  child.stdout?.on("data", (chunk: Buffer) => {
    heard();
    const text = chunk.toString("utf8");
    stdout += text;
    const lines = (partial + text).split(/\r?\n/);
    partial = lines.pop() ?? "";
    for (const line of lines) {
      const p = parseModelsMoveLine(line);
      if (p) { last = p; send(p); continue; }
      const b = parseModelsMoveBytes(line);
      if (b && last) send({ ...last, entry: b.entry, done: b.done, size: b.size });
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => { heard(); stderr += chunk.toString("utf8"); });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number | null, err?: Error) => {
      if (settled) return;
      settled = true;
      if (quiet) clearTimeout(quiet);
      if (kill) clearTimeout(kill);
      const dir = code === 0 && !err ? movedToFromStdout(stdout) : null;
      if (dir) { resolve({ ok: true, dir, leftovers: leftoversFromStdout(stdout) }); return; }
      // Killed before it could roll back: say what may be left.
      if (forced) { resolve({ ok: false, error: hung ? MOVE_HUNG_WORDS : MOVE_FORCED_WORDS }); return; }
      if (hung && /the move was stopped/.test(stderr)) {
        resolve({ ok: false, error: "The move stopped answering for 10 minutes, so it was stopped. Your models are back in the old folder." });
        return;
      }
      if (hung) { resolve({ ok: false, error: MOVE_HUNG_WORDS }); return; }
      if (err) { resolve({ ok: false, error: "Could not run the agent to move the models.", detail: err.message }); return; }
      const said = plainCliError(stderr);
      const detail = moveErrorDetail(said, code);
      resolve({ ok: false, error: moveErrorWords(said, code), ...(detail ? { detail } : {}) });
    };
    child.on("close", (code) => finish(code));
    child.on("error", (err) => finish(null, err));
  });
}

export interface ModelsFolderMoverDeps {
  /** Runs the move in the daemon's turn; `whenClosed` answers when the app is quitting. */
  turn?: <T>(run: () => Promise<T>, whenClosed: () => T) => Promise<T>;
  configLock?: <T>(run: () => Promise<T>) => Promise<T>;
  run?: (binary: string, args: string[], opts: RunMoveOptions) => Promise<ModelsFolderMoveAnswer>;
  send?: (p: ModelsFolderProgress) => void;
}

const CLOSED: ModelsFolderMoveAnswer = { ok: false, error: "The app is closing; the models were not moved." };

/** One move at a time, and the Cancel for it, queued while the move waits for its turn. */
export function createModelsFolderMover(deps: ModelsFolderMoverDeps = {}) {
  const turn = deps.turn ?? inDaemonTurn;
  const configLock = deps.configLock ?? withConfigLock;
  const run = deps.run ?? runMove;
  let moving = false;
  let cancelRequested = false;
  let stopMove: (() => void) | null = null;
  return {
    get moving(): boolean { return moving; },
    async move(binary: string, args: string[]): Promise<ModelsFolderMoveAnswer> {
      if (moving) return { ok: false, error: "The models are already being moved." };
      moving = true;
      cancelRequested = false;
      try {
        return await turn(
          () => configLock(() => {
            if (cancelRequested) return Promise.resolve({ ok: false, error: MOVE_CANCELLED_BEFORE_START_WORDS });
            return run(binary, args, { send: deps.send, onStop: (stop) => { stopMove = stop; } });
          }),
          () => CLOSED,
        );
      } finally {
        moving = false;
        cancelRequested = false;
        stopMove = null;
      }
    },
    cancel(): { ok: boolean; error?: string } {
      if (!moving) return { ok: false, error: "No move is under way." };
      if (stopMove) stopMove();
      else cancelRequested = true;
      return { ok: true };
    },
  };
}
