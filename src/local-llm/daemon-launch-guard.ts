import type { ChildProcess } from "node:child_process";
import { describeServerFault } from "./server-fault.js";

/**
 * The three checks that make a managed launch mean what it says.
 *
 * `startDaemon` used to spawn llama-server and then wait for *anything*
 * on the port to answer `/health`. When another llama-server already
 * held the port, the child died on `couldn't bind HTTP server socket`
 * inside a few milliseconds, the other server answered the wait, and the
 * start was reported as a success — every chat turn after it went to a
 * model the operator never picked. So a launch now has to prove:
 *
 *   1. the port was free before we spawned (`assertPortFree`),
 *   2. our child is the one that became healthy — its exit ends the wait
 *      at once with the log's reason (`waitForOwnDaemon`),
 *   3. the server on the port serves the alias we passed with `-a`.
 */

/**
 * The port already answers before we spawned. Not a `DaemonHealthError`
 * on purpose: the Windows CPU-backend fallback keys on that class, and a
 * port held by someone else would fail the CPU build identically.
 */
export class PortTakenError extends Error {
  constructor(
    readonly port: number,
    /** Model ids the holder serves (`/v1/models`), `[]` when it did not say. */
    readonly servedModels: readonly string[],
  ) {
    super(
      `port ${port} is already served by another process` +
        (servedModels.length > 0 ? ` (model ${servedModels.join(", ")})` : "") +
        " — stop it, or set a different localModels.managed.port",
    );
    this.name = "PortTakenError";
  }
}

/**
 * Model ids the server on `port` reports on `/v1/models` (llama-server
 * lists its `-a` alias there, and the route is exempt from `--api-key`).
 * `null` when nothing answered or the body was not the OpenAI shape.
 */
export async function fetchServedModelIds(
  port: number,
  timeoutMs = 2000,
): Promise<string[] | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as {
      data?: Array<{ id?: unknown }>;
    } | null;
    if (!body || !Array.isArray(body.data)) return null;
    return body.data
      .map((m) => m?.id)
      .filter((id): id is string => typeof id === "string");
  } catch {
    return null;
  }
}

/** True when anything at all answers HTTP on the port (any status). */
export async function isPortAnswering(
  port: number,
  timeoutMs = 1500,
): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return true;
  } catch {
    return false;
  }
}

export async function assertPortFree(port: number): Promise<void> {
  if (!(await isPortAnswering(port))) return;
  throw new PortTakenError(port, (await fetchServedModelIds(port)) ?? []);
}

export interface WaitForOwnDaemonOptions {
  child: ChildProcess;
  port: number;
  /** The `-a` alias the child was launched with. */
  alias: string;
  timeoutMs: number;
  /** "llama-server" / "embedding llama-server" — the error's subject. */
  label: string;
  probeHealth: (port: number) => Promise<"ok" | "loading" | "down">;
  readLog: () => string;
  /** Built by the caller so the Windows fallback keeps its error class. */
  makeHealthError: (message: string) => Error;
  pollMs?: number;
}

/**
 * Wait until the server on `port` is healthy AND is ours. Ends early
 * the moment the child exits, with the recognised fault from its log
 * (a bind failure becomes `PortTakenError`), instead of letting the
 * deadline run out or a neighbour's `/health` answer for it.
 */
export async function waitForOwnDaemon(
  opts: WaitForOwnDaemonOptions,
): Promise<void> {
  let exited: { code: number | null; signal: string | null } | null =
    opts.child.exitCode !== null || opts.child.signalCode !== null
      ? { code: opts.child.exitCode, signal: opts.child.signalCode }
      : null;
  const onExit = (code: number | null, signal: string | null) => {
    exited = { code, signal };
  };
  opts.child.once("exit", onExit);
  try {
    const pollMs = opts.pollMs ?? 250;
    const start = Date.now();
    while (Date.now() - start < opts.timeoutMs) {
      if (exited) break;
      if ((await opts.probeHealth(opts.port)) === "ok" && !exited) {
        await assertServesAlias(opts);
        return;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    const log = safeReadLog(opts.readLog);
    const fault = describeServerFault(log);
    if (exited) {
      if (fault && /could not take its port/.test(fault.summary)) {
        throw new PortTakenError(opts.port, (await fetchServedModelIds(opts.port)) ?? []);
      }
      const how = describeExit(exited);
      throw opts.makeHealthError(
        `${opts.label} exited (${how}) before it became healthy` +
          (fault ? ` — ${fault.summary}` : "") +
          `. Log tail:\n${tail(log)}`,
      );
    }
    throw opts.makeHealthError(
      `${opts.label} did not become healthy within ${opts.timeoutMs}ms` +
        (fault ? ` — ${fault.summary}` : "") +
        `. Log tail:\n${tail(log)}`,
    );
  } finally {
    opts.child.removeListener("exit", onExit);
  }
}

async function assertServesAlias(opts: WaitForOwnDaemonOptions): Promise<void> {
  const served = await fetchServedModelIds(opts.port);
  // A build without `/v1/models` says nothing either way; health plus a
  // live child is then the best evidence there is.
  if (served === null || served.includes(opts.alias)) return;
  throw opts.makeHealthError(
    `port ${opts.port} answered for model ${served.join(", ") || "(none)"}, not ${opts.alias} — ` +
      "another server is on the port",
  );
}

function describeExit(e: { code: number | null; signal: string | null }): string {
  if (e.signal) return `signal ${e.signal}`;
  return `code ${e.code ?? "unknown"}`;
}

function safeReadLog(read: () => string): string {
  try {
    return read();
  } catch {
    return "";
  }
}

function tail(log: string): string {
  if (!log) return "(no log)";
  return log.length > 4096 ? log.slice(-4096) : log;
}
