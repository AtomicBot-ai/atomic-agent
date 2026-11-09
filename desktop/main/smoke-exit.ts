/**
 * How a `--smoke` run ends, whatever happens on the way (ATO-896, ATO-825).
 *
 * ATO-896: the last step of smokeTest takes a screenshot of the window. On a
 * Mac whose screen slept or was locked, capturePage rejects ("Current display
 * surface not available for capture"); the rejection escaped smokeTest, the
 * app never exited and the job hung for over an hour with the run's model
 * server holding memory. The screenshot is optional, so it is taken through
 * `smokeScreenshot`, which never throws, and the whole suite runs through
 * `runSmokeGuarded`, which turns any escaped error into a failed, finished run.
 *
 * ATO-825: a smoke stopped midway (its terminal closed: SIGHUP, or SIGTERM /
 * SIGINT) left the run's Atomic Core and llama-server running on the run's
 * ports with the run's key; the next run then talked to them with its own key
 * and got "401 Invalid API Key" on every turn. So, for a smoke on a throwaway
 * state directory only (`smokeMayStopModels`), the quit's model-server stop
 * runs at the end of the run and on those signals, and the run refuses to
 * start when its model ports are already taken (`busyPorts`).
 *
 * Kept free of Electron so the suite can import it.
 */
import { createConnection } from "node:net";
import { isAbsolute, relative, resolve } from "node:path";

/**
 * Whether a smoke run may stop the model server it used. Only when the run's
 * state directory was named by the environment (the QA stand's per-run
 * folder), is not the operator's own terminal directory, and the model data
 * directory sits inside it — never a server the operator's own install, or a
 * directory outside the run, may be using.
 */
export function smokeMayStopModels(opts: {
  stateDir: string;
  tuiStateDir: string;
  stateDirFromEnv: boolean;
  dataDir: string;
}): boolean {
  if (!smokeOwnsItsState(opts)) return false;
  const rel = relative(resolve(opts.stateDir), resolve(opts.dataDir));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** A smoke on a throwaway directory: named by the environment, and not the operator's terminal directory. */
export function smokeOwnsItsState(opts: { stateDir: string; tuiStateDir: string; stateDirFromEnv: boolean }): boolean {
  return opts.stateDirFromEnv && resolve(opts.stateDir) !== resolve(opts.tuiStateDir);
}

/**
 * The final screenshot. Answers the line to print; never throws, so a screen
 * that cannot be captured costs the picture, not the run's verdict and exit.
 */
export async function smokeScreenshot(
  capture: () => Promise<{ toPNG: () => Buffer }>,
  write: (png: Buffer) => string,
  failures: number,
): Promise<string> {
  try {
    const image = await capture();
    const out = write(image.toPNG());
    return `SMOKE screenshot=${out} failures=${failures}\n`;
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return `SMOKE screenshot unavailable: ${why} failures=${failures}\n`;
  }
}

/**
 * Runs the suite; an error that escapes it ends the run as a failure through
 * `exit(1)` after printing why, instead of an unhandled rejection that leaves
 * the app (and its model server) running.
 */
export async function runSmokeGuarded(
  suite: () => Promise<void>,
  print: (line: string) => void,
  exit: (code: number) => void,
): Promise<void> {
  try {
    await suite();
  } catch (e) {
    const why = e instanceof Error ? (e.stack ?? e.message) : String(e);
    print(`FAIL smoke: the suite stopped on an error — ${why.split("\n").slice(0, 4).join(" | ")}\n`);
    exit(1);
  }
}

/** The signals a stopped QA job delivers: tmux kill-session sends SIGHUP; ^C, `kill` the rest. */
export const SMOKE_STOP_SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM"] as const;

/**
 * Wires `onStop` to the stop signals, once: a second signal while the first
 * one's cleanup runs is ignored rather than cutting it short (the cleanup is
 * bounded by its caller). The listeners stay registered (`on`, not `once`):
 * with `once`, a repeat of the SAME signal (a second ^C, `kill` sent twice)
 * found no listener and the default action killed the app mid-cleanup,
 * leaving the run's model server behind.
 */
export function onSmokeStopSignal(
  proc: { on: (sig: string, fn: () => void) => unknown },
  onStop: (signal: string) => void,
): void {
  let fired = false;
  for (const sig of SMOKE_STOP_SIGNALS) {
    proc.on(sig, () => {
      if (fired) return;
      fired = true;
      onStop(sig);
    });
  }
}

/** Exit code for a run ended by a signal, as a shell would report it. */
export function signalExitCode(signal: string): number {
  const n = ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as Record<string, number>)[signal];
  return n ? 128 + n : 1;
}

/** True when something already accepts connections on 127.0.0.1:`port`. */
export function portTaken(port: number, timeoutMs = 750): Promise<boolean> {
  return new Promise((done) => {
    const sock = createConnection({ host: "127.0.0.1", port });
    const finish = (taken: boolean) => { sock.removeAllListeners(); sock.destroy(); done(taken); };
    sock.setTimeout(timeoutMs, () => finish(false));
    sock.once("connect", () => finish(true));
    sock.once("error", () => finish(false));
  });
}

/** The model ports a run's config names (managed llama-server, embeddings). */
export function modelPortsOf(cfg: unknown): number[] {
  const lm = (cfg as { localModels?: Record<string, unknown> } | null)?.localModels;
  const managed = lm?.["managed"] as { port?: unknown } | undefined;
  const embeddings = lm?.["embeddings"] as { port?: unknown } | undefined;
  const ports = [managed?.port, embeddings?.port]
    .filter((p): p is number => typeof p === "number" && Number.isInteger(p) && p > 0 && p < 65536);
  return [...new Set(ports)];
}

/** Which of `ports` are already taken. */
export async function busyPorts(ports: readonly number[], taken: (port: number) => Promise<boolean> = portTaken): Promise<number[]> {
  const answers = await Promise.all(ports.map(async (p) => [p, await taken(p)] as const));
  return answers.filter(([, t]) => t).map(([p]) => p);
}
