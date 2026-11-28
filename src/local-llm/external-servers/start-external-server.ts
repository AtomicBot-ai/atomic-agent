/**
 * Start Ollama or LM Studio when it is installed but not running
 * (ATO-2490), then wait until the probe sees it.
 *
 * Ollama: the desktop app where there is one (macOS `open -a Ollama`, the
 * Windows tray app `ollama app.exe`), since that is how its owner runs it
 * and it stays up after we quit; otherwise `ollama serve`, detached, as
 * Linux installs it. LM Studio: `lms server start`.
 *
 * The process we spawn is detached and unreferenced: the server belongs to
 * its app, not to us, and quitting Atomic Agent never stops it.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import {
  detectLocalServers,
  type DetectedLocalServer,
  type LocalServerKind,
} from "../../llm/provider/presets/detect-local-servers.js";
import {
  currentHost,
  findOnPath,
  firstExisting,
  ollamaAppCandidates,
  ollamaBinaryCandidates,
  type HostPaths,
} from "./external-server-paths.js";
import { lmsServerStart, type LmsOptions } from "./lmstudio-cli.js";

export const OLLAMA_MISSING =
  "Ollama is not installed on this computer. Get it from ollama.com, then try again.";

/** How to start Ollama here, or null when nothing is installed. */
export type OllamaLaunch =
  | { readonly how: "app"; readonly command: string; readonly args: readonly string[] }
  | { readonly how: "serve"; readonly command: string; readonly args: readonly string[] };

export function planOllamaLaunch(
  host: HostPaths = currentHost(),
  exists: (path: string) => boolean = existsSync,
): OllamaLaunch | null {
  const app = firstExisting(ollamaAppCandidates(host), exists);
  if (app && host.platform === "darwin") return { how: "app", command: "open", args: ["-a", app] };
  if (app && host.platform === "win32") return { how: "app", command: app, args: [] };
  const bin = firstExisting(ollamaBinaryCandidates(host), exists) ?? findOnPath("ollama", host, exists);
  return bin ? { how: "serve", command: bin, args: ["serve"] } : null;
}

export type Spawner = (command: string, args: readonly string[]) => void;

export const detachedSpawn: Spawner = (command, args) => {
  const child = spawn(command, [...args], { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  child.unref();
};

export interface StartOptions {
  readonly host?: HostPaths;
  readonly exists?: (path: string) => boolean;
  readonly spawn?: Spawner;
  readonly detect?: () => Promise<DetectedLocalServer[]>;
  readonly lms?: LmsOptions;
  /** How long to wait for the server to answer. */
  readonly waitMs?: number;
  readonly pollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll the probe until `kind` answers. Null after `waitMs`. */
export async function waitForServer(kind: LocalServerKind, opts: StartOptions = {}): Promise<DetectedLocalServer | null> {
  const detect = opts.detect ?? (() => detectLocalServers());
  const sleep = opts.sleep ?? wait;
  const deadline = Date.now() + (opts.waitMs ?? 30_000);
  for (;;) {
    const hit = (await detect()).find((s) => s.kind === kind);
    if (hit) return hit;
    if (Date.now() >= deadline) return null;
    await sleep(opts.pollMs ?? 500);
  }
}

/**
 * Start a server and wait for it. Already running is a success with nothing
 * spawned. Throws a sentence for the screen when it cannot be started.
 */
export async function startExternalServer(
  kind: "ollama" | "lmstudio",
  opts: StartOptions = {},
): Promise<{ server: DetectedLocalServer; started: boolean }> {
  const detect = opts.detect ?? (() => detectLocalServers());
  const running = (await detect()).find((s) => s.kind === kind);
  if (running) return { server: running, started: false };
  if (kind === "ollama") {
    const plan = planOllamaLaunch(opts.host ?? currentHost(), opts.exists ?? existsSync);
    if (!plan) throw new Error(OLLAMA_MISSING);
    (opts.spawn ?? detachedSpawn)(plan.command, plan.args);
  } else {
    await lmsServerStart(opts.lms ?? {});
  }
  const server = await waitForServer(kind, { ...opts, detect });
  if (!server) {
    throw new Error(`${kind === "ollama" ? "Ollama" : "LM Studio"} was started but is not answering yet. Wait a moment and check again.`);
  }
  return { server, started: true };
}
