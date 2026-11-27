import { execFileSync } from "node:child_process";

/**
 * Every process below `root` (ATO-2277 review). A job on a pty runs
 * under `script(1)`, whose child calls `setsid`: the program and what it
 * starts (`nohup x &`, a disowned job) sit in other sessions and process
 * groups, so signalling the job's own group reaches only `script`.
 * These pids are signalled one by one as well. POSIX only; best-effort:
 * `[]` when `ps` cannot be run.
 */
export function descendantPids(
  root: number,
  readTable: () => string = () =>
    execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: 2_000 }),
): number[] {
  let table: string;
  try {
    table = readTable();
  } catch {
    return [];
  }
  return descendantsFromTable(root, table);
}

/** The descendants of `root` in a `pid ppid` table, nearest first. */
export function descendantsFromTable(root: number, table: string): number[] {
  const children = new Map<number, number[]>();
  for (const row of table.split("\n")) {
    const [pid, ppid] = row.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    const list = children.get(ppid!) ?? [];
    list.push(pid!);
    children.set(ppid!, list);
  }
  const found: number[] = [];
  const queue = [root];
  const seen = new Set([root]);
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

/** Signal each pid; one already gone is skipped. */
export function signalPids(pids: readonly number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // gone already
    }
  }
}
