import { execFileSync } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { basename } from "node:path";

import {
  resolveEmbeddingPidFilePath,
  resolvePidFilePath,
} from "../backend-paths.js";
import { fetchServedModelIds, isPortAnswering } from "./daemon-launch-guard.js";
import { findPortHolder, isStateDirInUse, type PortHolder } from "./port-holder.js";
import { hasOtherLiveSessions } from "./session-registry.js";

/**
 * Clear a managed port before a launch, so a start never meets a
 * `PortTakenError` it could have resolved itself. The rules, in order:
 *
 *   - our own data dir's llama-server serving the alias we want →
 *     **adopt** it (write its pid; the model is already warm);
 *   - our own data dir's llama-server serving anything else → **stop** it:
 *     the config it was launched for is gone, and every session of this
 *     data dir reads the same config;
 *   - another atomic-agent data dir's llama-server that nothing of that
 *     state dir is using (no live session marker, `sessions.sqlite` open
 *     by no process) → **stop** it: it outlived the run that started it;
 *   - anything else — another state dir still in use, Atomic Chat,
 *     Ollama, a server the operator runs by hand, a holder we cannot
 *     identify → never touched; **move** to the next free port.
 *
 * Parentless is not abandoned: a managed llama-server is spawned
 * detached on purpose, so a `ppid` of 1 is what a healthy daemon looks
 * like and is never read as evidence here.
 */

export type ReclaimOutcome =
  | { kind: "free" }
  | { kind: "adopted"; pid: number }
  | { kind: "stopped"; pid: number; why: string }
  | { kind: "moved"; port: number; why: string };

export interface ReclaimRequest {
  port: number;
  role: "chat" | "embedding";
  /** `config.paths.localModelsDataDir` of this process. */
  ownDataDir: string;
  /** The `-a` alias the launch would use (the catalog model id). */
  alias: string;
  /** Ports a move must not land on (the other daemon's). */
  avoidPorts: readonly number[];
}

export interface ReclaimDeps {
  findHolder: (port: number) => Promise<PortHolder | null>;
  servedModels: (port: number) => Promise<string[] | null>;
  stateDirInUse: (atagDataDir: string) => Promise<boolean>;
  liveSessions: (atagDataDir: string) => boolean;
  stopProcess: (pid: number) => Promise<void>;
  portOpen: (port: number) => Promise<boolean>;
  writePidFile: (dataDir: string, role: ReclaimRequest["role"], pid: number) => void;
  samePath: (a: string, b: string) => boolean;
  waitMs?: number;
}

export async function reclaimManagedPort(
  req: ReclaimRequest,
  deps: ReclaimDeps = defaultReclaimDeps(),
): Promise<ReclaimOutcome> {
  if (!(await deps.portOpen(req.port))) return { kind: "free" };

  const holder = await deps.findHolder(req.port);
  const verdict = await judgeHolder(req, holder, deps);
  if (verdict.kind === "adopt") {
    deps.writePidFile(req.ownDataDir, req.role, verdict.pid);
    return { kind: "adopted", pid: verdict.pid };
  }
  if (verdict.kind === "stop") {
    await deps.stopProcess(verdict.pid);
    if (await waitClosed(req.port, deps)) {
      return { kind: "stopped", pid: verdict.pid, why: verdict.why };
    }
    return move(req, deps, `${verdict.why}, but it did not release the port`);
  }
  return move(req, deps, verdict.why);
}

type Verdict =
  | { kind: "adopt"; pid: number }
  | { kind: "stop"; pid: number; why: string }
  | { kind: "leave"; why: string };

async function judgeHolder(
  req: ReclaimRequest,
  holder: PortHolder | null,
  deps: ReclaimDeps,
): Promise<Verdict> {
  if (!holder) {
    return { kind: "leave", why: `port ${req.port} is held by a process that could not be identified` };
  }
  // The name, not the path: the line has to fit a feed row, and the
  // state dir — the part that matters for an atomic-agent holder — is
  // named separately below.
  const who = `pid ${holder.pid} (${holder.executable ? basename(holder.executable) : "unknown executable"})`;
  if (!holder.atagDataDir) {
    return { kind: "leave", why: `port ${req.port} is held by ${who}, which is not an atomic-agent server` };
  }
  if (deps.samePath(holder.atagDataDir, req.ownDataDir)) {
    const served = await deps.servedModels(req.port);
    if (served !== null && served.includes(req.alias)) {
      return { kind: "adopt", pid: holder.pid };
    }
    return {
      kind: "stop",
      pid: holder.pid,
      why: `stopped our own llama-server ${who}: it served ${served?.join(", ") || "another model"}, not ${req.alias}`,
    };
  }
  if (deps.liveSessions(holder.atagDataDir) || (await deps.stateDirInUse(holder.atagDataDir))) {
    return {
      kind: "leave",
      why: `port ${req.port} is held by ${who}, which another running atomic-agent (${holder.atagDataDir}) is using`,
    };
  }
  return {
    kind: "stop",
    pid: holder.pid,
    why: `stopped a leftover llama-server ${who} — nothing of ${holder.atagDataDir} is running`,
  };
}

async function waitClosed(port: number, deps: ReclaimDeps): Promise<boolean> {
  const deadline = Date.now() + (deps.waitMs ?? 5000);
  while (Date.now() < deadline) {
    if (!(await deps.portOpen(port))) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !(await deps.portOpen(port));
}

async function move(
  req: ReclaimRequest,
  deps: ReclaimDeps,
  why: string,
): Promise<ReclaimOutcome> {
  for (let p = req.port + 1; p < req.port + 64 && p <= 65_535; p += 1) {
    if (req.avoidPorts.includes(p)) continue;
    if (!(await deps.portOpen(p))) return { kind: "moved", port: p, why };
  }
  throw new Error(`${why}; no free port found near ${req.port}`);
}

/** Open = something accepts on it: an HTTP answer, or a bind that fails. */
export async function isPortOpen(port: number): Promise<boolean> {
  if (await isPortAnswering(port, 800)) return true;
  return !(await canBind(port));
}

function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/** SIGTERM, up to 5 s grace, then SIGKILL (`taskkill /F` on Windows). */
export async function stopProcess(pid: number): Promise<void> {
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        timeout: 5000,
        stdio: "ignore",
      });
    } catch {
      /* gone already, or not ours to kill — the port check decides */
    }
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* exited on its own at the last moment */
  }
}

function samePath(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return real(a) === real(b);
}

export function defaultReclaimDeps(): ReclaimDeps {
  return {
    findHolder: (port) => findPortHolder(port),
    servedModels: (port) => fetchServedModelIds(port),
    stateDirInUse: (dir) => isStateDirInUse(dir),
    liveSessions: (dir) => hasOtherLiveSessions(dir),
    stopProcess,
    portOpen: isPortOpen,
    writePidFile: (dataDir, role, pid) =>
      writeFileSync(
        role === "embedding"
          ? resolveEmbeddingPidFilePath(dataDir)
          : resolvePidFilePath(dataDir),
        String(pid),
        "utf-8",
      ),
    samePath,
  };
}

/** One feed line per decision; `null` when there was nothing to decide. */
export function describeReclaim(
  outcome: ReclaimOutcome,
  label: string,
  port: number,
): string | null {
  switch (outcome.kind) {
    case "free":
      return null;
    case "adopted":
      return `local-llm: ${label} — adopted our own server already on port ${port} (pid ${outcome.pid})`;
    case "stopped":
      return `local-llm: ${label} — ${outcome.why}`;
    case "moved":
      // Outcome first: the reason can be long, and a feed row is cut.
      return `local-llm: ${label} on port ${outcome.port} (saved to config) — ${outcome.why}`;
  }
}
