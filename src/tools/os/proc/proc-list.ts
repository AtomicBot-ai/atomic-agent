import { compressToolResult } from "../../../compressor/result-compressor.js";
import type { ToolDefinition } from "../../tool-registry.js";
import { runCommand } from "../../../sandbox/command-runner.js";

/**
 * One row in the process table. We normalise field names across platforms
 * (POSIX `ps` vs Windows `tasklist`) so the grammar + descriptor stay
 * platform-agnostic.
 */
export interface ProcessInfo {
  pid: number;
  ppid: number | null;
  user: string;
  cpuPercent: number | null;
  memPercent: number | null;
  command: string;
}

interface ListArgs {
  filter?: string;
  limit: number;
}

const DEFAULT_LIMIT = 500;

export const osProcListTool: ToolDefinition = {
  name: "os.proc.list",
  description:
    "Snapshot the running processes. Returns PID/PPID/user/CPU%/MEM%/command per row. Args: `filter` (substring match on command, case-insensitive), `limit` (default 500).",
  readonly: true,
  async run(rawArgs, ctx) {
    const args = parseArgs(rawArgs);
    const rows = await collectProcessRows(ctx.signal);
    let filtered = rows;
    if (args.filter) {
      const needle = args.filter.toLowerCase();
      filtered = rows.filter((r) => r.command.toLowerCase().includes(needle));
    }
    const limited = filtered.slice(0, args.limit);
    return compressToolResult({
      tool: "os.proc.list",
      status: "ok",
      output: formatTable(limited),
      details: {
        total: rows.length,
        matched: filtered.length,
        returned: limited.length,
        truncated: filtered.length > limited.length,
        processes: limited,
      },
    });
  },
};

function parseArgs(raw: Record<string, unknown>): ListArgs {
  const filter =
    typeof raw.filter === "string" && raw.filter.length > 0
      ? raw.filter
      : undefined;
  let limit = DEFAULT_LIMIT;
  if (raw.limit !== undefined && raw.limit !== null) {
    if (typeof raw.limit !== "number" || !Number.isFinite(raw.limit) || raw.limit <= 0) {
      throw new Error("os.proc.list: `limit` must be a positive number");
    }
    limit = Math.min(5000, Math.floor(raw.limit));
  }
  return filter !== undefined ? { filter, limit } : { limit };
}

async function collectProcessRows(signal: AbortSignal): Promise<ProcessInfo[]> {
  if (process.platform === "win32") return collectWindows(signal);
  return collectPosix(signal);
}

/**
 * POSIX path — single `ps` call with an explicit column set. `-eo` is
 * portable across Linux and macOS (BSD ps understands it too).
 */
async function collectPosix(signal: AbortSignal): Promise<ProcessInfo[]> {
  const result = await runCommand(
    "ps",
    ["-eo", "pid=,ppid=,user=,pcpu=,pmem=,comm="],
    {
      cwd: process.cwd(),
      signal,
      timeoutMs: 15_000,
      maxOutputBytes: 4 * 1024 * 1024,
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `os.proc.list: ps exited with ${result.exitCode}: ${result.stderr.trim()}`,
    );
  }
  const rows: ProcessInfo[] = [];
  for (const raw of result.stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    // Columns: pid ppid user pcpu pmem comm (comm may contain spaces)
    const match = line.match(
      /^(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(.+)$/,
    );
    if (!match) continue;
    const [, pid, ppid, user, pcpu, pmem, comm] = match as unknown as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    rows.push({
      pid: Number(pid),
      ppid: Number(ppid),
      user,
      cpuPercent: Number(pcpu),
      memPercent: Number(pmem),
      command: comm,
    });
  }
  return rows;
}

/**
 * Windows path — `tasklist /FO CSV /V` gives verbose output with user,
 * CPU time, and memory. We skip the header row.
 */
async function collectWindows(signal: AbortSignal): Promise<ProcessInfo[]> {
  const result = await runCommand("tasklist", ["/FO", "CSV", "/NH", "/V"], {
    cwd: process.cwd(),
    signal,
    timeoutMs: 15_000,
    maxOutputBytes: 4 * 1024 * 1024,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `os.proc.list: tasklist exited with ${result.exitCode}: ${result.stderr.trim()}`,
    );
  }
  const rows: ProcessInfo[] = [];
  for (const raw of result.stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const fields = parseCsvRow(line);
    // Expected columns (tasklist /V): Image Name, PID, Session Name,
    // Session#, Mem Usage, Status, User Name, CPU Time, Window Title.
    if (fields.length < 8) continue;
    const pid = Number(fields[1]);
    if (!Number.isFinite(pid)) continue;
    rows.push({
      pid,
      ppid: null,
      user: fields[6] ?? "",
      cpuPercent: null,
      memPercent: null,
      command: fields[0] ?? "",
    });
  }
  return rows;
}

function parseCsvRow(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      out.push(field);
      field = "";
    } else {
      field += c;
    }
  }
  out.push(field);
  return out;
}

function formatTable(rows: readonly ProcessInfo[]): string {
  if (rows.length === 0) return "(no processes matched)";
  const header =
    "PID      PPID     USER               CPU%   MEM%   COMMAND";
  const lines = [header];
  for (const r of rows) {
    lines.push(
      `${String(r.pid).padEnd(8)} ` +
        `${r.ppid === null ? "-" : String(r.ppid).padEnd(8)} ` +
        `${(r.user || "-").padEnd(18)} ` +
        `${formatPct(r.cpuPercent)} ` +
        `${formatPct(r.memPercent)} ` +
        `${r.command}`,
    );
  }
  return lines.join("\n");
}

function formatPct(v: number | null): string {
  if (v === null) return "-    ";
  return v.toFixed(1).padStart(5);
}
