import { compressToolResult } from "../../../compressor/result-compressor.js";
import type { ToolDefinition } from "../../tool-registry.js";
import { runCommand } from "../../../sandbox/command-runner.js";
import {
  requireApproval,
  type DangerousToolOptions,
} from "../../../approval/dangerous-tool.js";

export type KillSignal = "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP";

const SUPPORTED_SIGNALS: readonly KillSignal[] = [
  "SIGTERM",
  "SIGKILL",
  "SIGINT",
  "SIGHUP",
];

interface KillArgs {
  pid: number;
  signal: KillSignal;
}

/**
 * Dangerous tool. Always requires approval; preview includes a snapshot
 * of the target process (name + user) so the operator can sanity-check
 * that the PID points at what they expect before the signal flies.
 */
export function buildOsProcKillTool(
  options: DangerousToolOptions,
): ToolDefinition {
  return {
    name: "os.proc.kill",
    description:
      "Send a signal to a process by PID. Dangerous — always requires approval. Args: `pid` (required), `signal` (SIGTERM|SIGKILL|SIGINT|SIGHUP, default SIGTERM).",
    readonly: false,
    async run(rawArgs, ctx) {
      const args = parseArgs(rawArgs);
      const preview = await describeTarget(args.pid, ctx.signal);
      await requireApproval(
        options,
        {
          sessionId: ctx.sessionId,
          tool: "os.proc.kill",
          category: "proc_kill",
          reason: `send ${args.signal} to pid ${args.pid}`,
          preview,
          affectedResources: [`pid:${args.pid}`],
        },
        ctx.signal,
      );

      const sent = await sendSignal(args.pid, args.signal);
      return compressToolResult({
        tool: "os.proc.kill",
        status: sent.ok ? "ok" : "error",
        output: sent.ok
          ? `sent ${args.signal} to pid ${args.pid}`
          : `failed to send ${args.signal} to pid ${args.pid}: ${sent.error}`,
        details: {
          pid: args.pid,
          signal: args.signal,
          success: sent.ok,
          error: sent.error ?? null,
          preview,
        },
      });
    },
  };
}

function parseArgs(raw: Record<string, unknown>): KillArgs {
  if (typeof raw.pid !== "number" || !Number.isFinite(raw.pid) || raw.pid <= 0) {
    throw new Error("os.proc.kill: `pid` must be a positive number");
  }
  const pid = Math.floor(raw.pid);
  let signal: KillSignal = "SIGTERM";
  if (raw.signal !== undefined && raw.signal !== null) {
    if (typeof raw.signal !== "string") {
      throw new Error("os.proc.kill: `signal` must be a string");
    }
    const upper = raw.signal.toUpperCase();
    if (!(SUPPORTED_SIGNALS as readonly string[]).includes(upper)) {
      throw new Error(
        `os.proc.kill: unsupported signal ${JSON.stringify(raw.signal)} (supported: ${SUPPORTED_SIGNALS.join(", ")})`,
      );
    }
    signal = upper as KillSignal;
  }
  return { pid, signal };
}

async function describeTarget(
  pid: number,
  signal: AbortSignal,
): Promise<string> {
  try {
    if (process.platform === "win32") {
      const res = await runCommand(
        "tasklist",
        ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
        { cwd: process.cwd(), signal, timeoutMs: 5_000 },
      );
      const line = res.stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
      return line ? `target: ${line}` : `target pid ${pid} not found`;
    }
    const res = await runCommand(
      "ps",
      ["-o", "pid=,user=,comm=", "-p", String(pid)],
      { cwd: process.cwd(), signal, timeoutMs: 5_000 },
    );
    const line = res.stdout.trim();
    return line ? `target: ${line}` : `target pid ${pid} not found`;
  } catch (err) {
    return `(could not resolve target: ${(err as Error).message})`;
  }
}

type SendResult = { ok: true; error: null } | { ok: false; error: string };

async function sendSignal(
  pid: number,
  signal: KillSignal,
): Promise<SendResult> {
  // Windows `process.kill` cannot deliver POSIX signals to arbitrary
  // processes (SIGHUP throws EINVAL). Map onto `taskkill`: SIGKILL forces
  // termination (`/F`), the softer signals request a graceful close.
  if (process.platform === "win32") {
    const force = signal === "SIGKILL";
    const taskkillArgs = force
      ? ["/PID", String(pid), "/F"]
      : ["/PID", String(pid)];
    try {
      const res = await runCommand("taskkill", taskkillArgs, {
        cwd: process.cwd(),
        timeoutMs: 5_000,
      });
      if (res.exitCode === 0) return { ok: true, error: null };
      return {
        ok: false,
        error: res.stderr.trim() || `taskkill exited with ${res.exitCode}`,
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
  try {
    process.kill(pid, signal);
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
