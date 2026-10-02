import { readFileSync } from "node:fs";
import { join } from "node:path";

import { onDaemonLifecycle, portAnswer, startsInFlight } from "./agent-cli.js";
import { bringUpAtLaunch, bringUpInFlight, runModeWantsDaemon } from "./backend-switch.js";
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
 * stops on purpose for whose it is. main.ts arms it (not in a smoke run,
 * where checks kill model servers by hand on purpose), feeds it the agent's
 * `provider_waiting` frames, and passes its notices to the window.
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
  llm?: NonNullable<RunModeConfig["llm"]> & { providers?: Array<RunModeProvider & { url?: string; baseUrl?: string }> };
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
 * with a local seat. And `localModels.managed.autoRestart`, the terminal's
 * own switch for this (default on).
 */
export function routeWantsRestarts(cfg: WatchConfig | null): boolean {
  if (!cfg) return false;
  const lm = cfg.localModels;
  if (lm?.mode !== "managed" || !lm.managed?.modelId) return false;
  if (lm.managed.autoRestart === false) return false;
  const active = cfg.llm ? cfg.llm.activeTextProvider : "local-llama";
  const entry = cfg.llm?.providers?.find((p) => p.id === active);
  const localRoute = !cfg.llm || (!!entry && entry.kind === "llama-server");
  return localRoute || runModeWantsDaemon(resolveRunMode(cfg), lm);
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

/** The server at one look: busy while anything brings it up or replaces it; down when its pid is gone or its port refuses. */
async function look(): Promise<DaemonLook> {
  if (startsInFlight() > 0 || bringUpInFlight() || host.busy()) return "busy";
  const cfg = readConfig();
  const pid = chatDaemonPid(cfg);
  if (pid !== null && !pidAlive(pid)) return "down";
  const answer = await portAnswer(managedPort(cfg), 2_000);
  // Any HTTP answer (503 while a model loads) or a listener too busy to answer in time is a server that is there.
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
