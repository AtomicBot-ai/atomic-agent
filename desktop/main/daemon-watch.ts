import { readFileSync } from "node:fs";
import { join } from "node:path";

import { onDaemonLifecycle, portAnswer, startsInFlight } from "./agent-cli.js";
import { bringUpAtLaunch, bringUpInFlight, daemonTurnsOnTheirWay, runModeWantsDaemon, stopsMark } from "./backend-switch.js";
import {
  DaemonSupervisor,
  type DaemonLook,
  type DaemonSupervisorDeps,
  type SupervisorNotice,
  type SupervisorState,
} from "./daemon-supervisor.js";
import { isLoopbackOnPort, managedDataDir } from "./local-llama-key.js";
import { resolveRunMode, type RunModeConfig, type RunModeProvider } from "./run-mode.js";
import { DESKTOP_STATE_DIR } from "./state-dir.js";

/**
 * ATO-123 — the app's own DaemonSupervisor (daemon-supervisor.ts), wired to
 * the real thing: the config file for whether the route needs the managed
 * server, its pid file and its port for whether it is up, the background
 * bring-up (backend-switch) to start it again, and agent-cli's starts and
 * stops on purpose for whose it is — a start the app asks for that finds the
 * server already up counts as one it made (agent-cli daemonFoundUp). main.ts
 * arms it (not in a smoke run, where checks kill model servers by hand on
 * purpose), feeds it the agent's `provider_waiting` frames, tells it of the
 * llama.cpp update (updateBegins, afterUpdate), and passes its notices to the
 * window.
 */

/** What this module reads of `<stateDir>/config.json`. */
interface WatchConfig extends RunModeConfig {
  localModels?: {
    mode?: string;
    managed?: {
      modelId?: string | null;
      port?: number;
      dataDirOverride?: string | null;
      autoRestart?: boolean;
      parallel?: number | string;
    };
  };
  /* The run-mode block, with the provider entries' own urls: `providers` is
     replaced, not intersected — an intersection of the two array types reads
     as RunModeProvider[] to `.find`, and the urls would not be there. */
  llm?: Omit<NonNullable<RunModeConfig["llm"]>, "providers"> & {
    providers?: Array<RunModeProvider & { url?: string; baseUrl?: string }>;
  };
}

/** The agent's default managed port (src/config/config-schema.ts), when the file names none. */
const DEFAULT_MANAGED_PORT = 19091;

function readConfig(): WatchConfig | null {
  try {
    return JSON.parse(readFileSync(join(DESKTOP_STATE_DIR, "config.json"), "utf8")) as WatchConfig;
  } catch {
    return null;
  }
}

function managedPort(cfg: WatchConfig | null): number {
  const port = cfg?.localModels?.managed?.port;
  return typeof port === "number" && Number.isInteger(port) && port > 0 ? port : DEFAULT_MANAGED_PORT;
}

/**
 * Whether the route in the file needs the managed server now — the test
 * main.ts's launch start makes (startLocalDaemonAtBoot): the managed mode
 * with a model chosen, and Local models as the route (a `llama-server`
 * entry, or no `llm` block at all, which the agent reads as local) or Fusion
 * with a local seat.
 */
export function routeNeedsDaemon(cfg: WatchConfig | null): boolean {
  if (!cfg) return false;
  const lm = cfg.localModels;
  if (lm?.mode !== "managed" || !lm.managed?.modelId) return false;
  const active = cfg.llm ? cfg.llm.activeTextProvider : "local-llama";
  const entry = cfg.llm?.providers?.find((p) => p.id === active);
  const localRoute = !cfg.llm || (!!entry && entry.kind === "llama-server");
  return localRoute || runModeWantsDaemon(resolveRunMode(cfg), lm);
}

/** routeNeedsDaemon, and `localModels.managed.autoRestart` — the terminal's own switch for restarts (default on). */
export function routeWantsRestarts(cfg: WatchConfig | null): boolean {
  return routeNeedsDaemon(cfg) && cfg?.localModels?.managed?.autoRestart !== false;
}

/**
 * Whether the provider a turn waits on is the managed server: `local-llama`,
 * or a `llama-server` entry on the managed port.
 */
export function isManagedServer(providerId: string, cfg: WatchConfig | null): boolean {
  if (providerId === "local-llama") return true;
  const entry = cfg?.llm?.providers?.find((p) => p.id === providerId);
  if (!entry || entry.kind !== "llama-server") return false;
  const url = entry.url ?? entry.baseUrl ?? "";
  return isLoopbackOnPort(url, [managedPort(cfg)]);
}

/** The chat server's pid from its pid file, or null (src/local-llm/backend-paths.ts: `llama-server.pid`). */
function chatDaemonPid(cfg: WatchConfig | null): number | null {
  try {
    const dir = managedDataDir(cfg?.localModels?.managed?.dataDirOverride ?? null);
    const pid = Number(readFileSync(join(dir, "llama-server.pid"), "utf8").trim());
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: alive, and not ours to signal — still alive.
    return (err as { code?: string }).code === "EPERM";
  }
}

/** One line from the end of the server's log that says what failed, or null. */
function describeFault(): string | null {
  try {
    const cfg = readConfig();
    const dir = managedDataDir(cfg?.localModels?.managed?.dataDirOverride ?? null);
    const raw = readFileSync(join(dir, "llama-server.log"), "utf8");
    const lines = raw.slice(-16_384).split("\n").map((l) => l.trim()).filter(Boolean).slice(-80);
    const hit = [...lines].reverse().find((l) =>
      /out of memory|failed to (load|allocate|initiali[sz]e)|error loading model|couldn'?t bind|address already in use|abort|segmentation fault/i.test(l),
    );
    return hit ? (hit.length > 160 ? `${hit.slice(0, 157)}…` : hit) : null;
  } catch {
    return null;
  }
}

/** What main hands in: where notices go, and what else counts as busy (the llama.cpp update). */
export interface DaemonWatchHost {
  notify: (notice: SupervisorNotice) => void;
  say: (line: string) => void;
  /** A llama.cpp update running: it stops the server and replaces its binary. */
  busy: () => boolean;
}

let host: DaemonWatchHost = { notify: () => {}, say: () => {}, busy: () => false };

/**
 * The server at one look: busy while anything brings it up, stops it to start
 * it again or replaces its binary — a daemon turn on its way or running (a
 * model pick, Settings' Start repairing a wedged server, the llama.cpp
 * update), a background bring-up, a `models start` — else what probe() says.
 */
async function look(): Promise<DaemonLook> {
  if (busyNow()) return "busy";
  const seen = await probe();
  // The probe takes up to 2.5 s: one of those may have begun meanwhile, and then what it saw is moot.
  return busyNow() ? "busy" : seen;
}

function busyNow(): boolean {
  return daemonTurnsOnTheirWay() > 0 || startsInFlight() > 0 || bringUpInFlight() !== null || host.busy();
}

/** Down when the pid file names a dead pid or the port refuses; any HTTP answer (503 while a model loads), or a listener too busy to answer in time, is a server that is there. */
async function probe(): Promise<"up" | "down"> {
  const cfg = readConfig();
  const pid = chatDaemonPid(cfg);
  if (pid !== null && !pidAlive(pid)) return "down";
  // portAnswer's own 2.5 s: Windows takes about two seconds to refuse a closed local port, and a refusal cut short reads as up.
  const answer = await portAnswer(managedPort(cfg));
  return answer.kind === "refused" ? "down" : "up";
}

/** The background bring-up a launch makes (backend-switch): in the daemon's turn, and ended at once by a stop or a switch. */
async function restart(): Promise<{ ok: boolean; superseded?: boolean; error?: string }> {
  const modelId = readConfig()?.localModels?.managed?.modelId ?? "";
  const r = await bringUpAtLaunch(modelId);
  if (r.daemon === "started" || r.daemon === "untouched") return { ok: true };
  if (r.daemon === "superseded") return { ok: false, superseded: true };
  return { ok: false, error: r.error ?? (r.daemon === "skipped" ? "the model is not on disk" : `the start ended as ${r.daemon}`) };
}

/**
 * ATO-123, the llama.cpp update (Nadya's decision, 02.10): `atag models
 * update` stops the model server itself when there is a newer llama.cpp to
 * install, and never starts it again (src/cli/models-handlers.ts). Told
 * nothing, the supervisor saw a server the app had started go down, brought it
 * back a few seconds after the update with "stopped — starting it again", and
 * counted a quick death. The update is a stop on purpose instead, said as it
 * begins — in the daemon's turn, where nothing else starts or stops the
 * server — and afterUpdate puts back what it took.
 */
export interface UpdateHold {
  /** The server was the app's, with the supervisor on, when the update began. */
  wasOwned: boolean;
  /** backend-switch's stops mark then: a stop, a switch or a model change since is the last word. */
  mark: number;
}

/**
 * main.ts, as a llama.cpp update begins in its daemon turn. Only with the
 * supervisor on — in every real run, and never in a smoke run, whose checks
 * (T18) count each `models start` an update is followed by.
 */
export function updateBegins(): UpdateHold {
  const st = daemonWatch.state();
  const wasOwned = st.armed && st.owned;
  daemonWatch.noteStopped();
  if (wasOwned) host.say("[desktop] local-llm: the llama.cpp update may stop the model server to replace its binary — it is started again after a successful update");
  return { wasOwned, mark: stopsMark() };
}

/**
 * main.ts, once the update is over and out of the daemon's turn. A server the
 * update left running is the app's again. One it stopped is started again,
 * quietly, after a successful update when the route needs it; after a failed
 * one it is left as the update left it, and the update's answer says so — the
 * line Settings › Models shows for it. ATO-128: an update stopped by its own
 * time limit (`keptBackend`) left the llama.cpp in place untouched — the agent
 * swaps a staged copy in only at the very end — so the server it stopped is
 * started again on that one, as after a successful update.
 */
export async function afterUpdate<T extends { ok: boolean; error?: string; stdout?: string }>(
  res: T,
  hold: UpdateHold,
  opts: { keptBackend?: boolean } = {},
): Promise<T> {
  // A stop, a switch or a model change while the update ran (Settings' Stop stays live through it): theirs is the last word.
  const movedOn = () => stopsMark() !== hold.mark;
  if (!hold.wasOwned || movedOn()) return res;
  const now = await probe();
  if (movedOn()) return res;
  if (now === "up") {
    daemonWatch.noteStarted();
    return res;
  }
  if (!res.ok && !opts.keptBackend) {
    return {
      ...res,
      error: `${res.error ?? "the update failed"} — the local model server it stopped is still stopped; start it in Settings › Models`,
    };
  }
  if (!routeNeedsDaemon(readConfig())) return res;
  const modelId = readConfig()?.localModels?.managed?.modelId ?? "";
  /* The background bring-up: in its turn, and ended at once by a stop or a
     switch; its start makes the server the app's again, and the window hears
     how it went as it hears a ⇄'s (via "update"). The update's own last line
     tells the terminal to start it by hand; here the app does. */
  void bringUpAtLaunch(modelId, "update").catch(() => undefined);
  if (!res.ok) return res;
  return typeof res.stdout === "string"
    ? { ...res, stdout: `${res.stdout.trimEnd()}\nthe local model server is starting again on the new backend` }
    : res;
}

const deps: DaemonSupervisorDeps = {
  wanted: () => routeWantsRestarts(readConfig()),
  look,
  restart,
  notify: (n) => host.notify(n),
  say: (line) => host.say(line),
  describeFault,
};

/** The one supervisor the app runs. */
export const daemonWatch = new DaemonSupervisor(deps);

/* Every start the app makes, and every stop it makes on purpose, through agent-cli.
   A stop is also written to the agent log, with the route the file names as it
   happens: in Valera's case llama-server.log said the server was asked to
   close twelve seconds after it came up, and nothing said who asked. */
onDaemonLifecycle((e) => {
  if (e === "started") {
    daemonWatch.noteStarted();
    return;
  }
  daemonWatch.noteStopped();
  const cfg = readConfig();
  const route = cfg?.llm?.activeTextProvider ?? "local-llama";
  const mode = cfg?.llm?.runMode?.mode;
  host.say(`[desktop] local-llm: the app is stopping the model server (route ${route}${mode ? `, run mode ${mode}` : ""})`);
});

/** main.ts: where notices go and what else is busy. Hands back the host it replaces. */
export function hostDaemonWatch(next: DaemonWatchHost): DaemonWatchHost {
  const was = host;
  host = next;
  return was;
}

/**
 * main.ts, for every chat frame the agent streams: a turn waiting on the
 * managed server because it refuses connections (item 29's `provider_id` and
 * `cause`) is the agent seeing the server gone — look at once.
 */
export function onAgentFrame(ev: { kind?: unknown; payload?: unknown }): void {
  if (ev.kind !== "provider_waiting") return;
  const p = (ev.payload ?? {}) as { provider_id?: unknown; cause?: { kind?: unknown } | null };
  if (typeof p.provider_id !== "string" || p.cause?.kind !== "refused") return;
  if (!isManagedServer(p.provider_id, readConfig())) return;
  void daemonWatch.checkNow("the agent could not reach the local model server").catch(() => undefined);
}

/** For the window (a reopened one asks) and the smoke. */
export function daemonWatchState(): SupervisorState {
  return daemonWatch.state();
}
