import { execFile } from "node:child_process";
import { freemem, totalmem } from "node:os";

/**
 * Whether this computer has the memory to start a local embedding model
 * for memory (ATO-379). On a machine that is short of memory the model is
 * not started: memory search uses keywords (FTS5), which needs no model,
 * and the operator gets one short note instead.
 *
 * Only a start is gated. A model that already runs keeps running (its
 * memory is already spent), and a remote embedding provider is never
 * checked: neither starts anything on this machine.
 */

const GIB = 1024 * 1024 * 1024;

/**
 * Smallest total RAM that starts the memory model. Below 8 GB the chat
 * model already competes with the system for every gigabyte. The floor
 * sits under 8 GiB because an 8 GB Linux or Windows machine reports a
 * little less than that (firmware and integrated GPU reserve some), and
 * such a machine should keep the model.
 */
export const EMBEDDING_MIN_TOTAL_RAM_BYTES = 7.5 * GIB;

/**
 * Smallest available memory that starts the memory model: the model
 * itself (about 300 MB for EmbeddingGemma 2) plus headroom for the
 * llama.cpp process and the system. A larger model needs twice its file
 * size when that is more.
 */
export const EMBEDDING_MIN_AVAILABLE_RAM_BYTES = 1 * GIB;

/** How long `vm_stat` may take before the check falls back to `os.freemem()`. */
const VM_STAT_TIMEOUT_MS = 1000;

export interface SystemMemory {
  /** Physical RAM in bytes. */
  totalBytes: number;
  /**
   * Memory a new process can get without swapping, in bytes; `null` when
   * it could not be read (the check then looks at total RAM only).
   */
  availableBytes: number | null;
}

export type EmbeddingMemoryCheck =
  | { ok: true }
  | {
      ok: false;
      reason: "total" | "available";
      /** One line for the operator. */
      note: string;
      /** The figures behind it, for logs. */
      detail: string;
    };

/**
 * Available memory from `vm_stat` output: free, inactive and speculative
 * pages. `os.freemem()` on macOS counts free pages only, which leaves out
 * the file cache macOS hands back on demand, so a Mac with plenty of room
 * looks almost full. Purgeable pages are left out: they sit in the
 * active/inactive queues already. `null` when the output has no page size
 * or no free count.
 */
export function parseVmStatAvailableBytes(output: string): number | null {
  const pageSize = /page size of (\d+) bytes/.exec(output);
  if (!pageSize) return null;
  const pages = (label: string): number | null => {
    const m = new RegExp(`^Pages ${label}:\\s+(\\d+)\\.?\\s*$`, "m").exec(output);
    return m ? Number(m[1]) : null;
  };
  const free = pages("free");
  if (free === null) return null;
  const reclaimable = free + (pages("inactive") ?? 0) + (pages("speculative") ?? 0);
  return reclaimable * Number(pageSize[1]);
}

function readVmStat(): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile("vm_stat", [], { timeout: VM_STAT_TIMEOUT_MS, encoding: "utf8" }, (err, stdout) => {
        resolve(err ? null : stdout);
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * Total and available memory of this machine. On Linux `os.freemem()` is
 * the kernel's MemAvailable and on Windows the available physical memory,
 * both of which already count reclaimable cache; macOS asks `vm_stat`
 * (see `parseVmStatAvailableBytes`). Never throws.
 */
export async function readSystemMemory(
  deps: {
    platform?: NodeJS.Platform;
    vmStat?: () => Promise<string | null>;
    freeBytes?: () => number;
    totalBytes?: () => number;
  } = {},
): Promise<SystemMemory> {
  const platform = deps.platform ?? process.platform;
  const totalBytes = (deps.totalBytes ?? totalmem)();
  if (platform === "darwin") {
    const out = await (deps.vmStat ?? readVmStat)().catch(() => null);
    const available = out === null ? null : parseVmStatAvailableBytes(out);
    // Without vm_stat the free-page count would understate a Mac's room,
    // so the check falls back to total RAM rather than skip on a guess.
    return { totalBytes, availableBytes: available };
  }
  let availableBytes: number | null;
  try {
    availableBytes = (deps.freeBytes ?? freemem)();
  } catch {
    availableBytes = null;
  }
  return { totalBytes, availableBytes };
}

/** `~300 MB` for a model file of `fileSizeGb`: rounded to 100 MB, at least 100. */
function approxModelSize(fileSizeGb: number): string {
  const mb = Math.max(100, Math.round((fileSizeGb * 1000) / 100) * 100);
  return `~${mb} MB`;
}

/** The operator's note when the memory model is not started for lack of memory. */
export function lowMemoryEmbeddingNote(fileSizeGb: number): string {
  return `Memory search uses keywords: not enough free memory for the memory model (needs ${approxModelSize(fileSizeGb)}).`;
}

function gb(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GB`;
}

/**
 * Whether `memory` leaves room for an embedding model of `fileSizeGb`.
 * Pure: the figures come from `readSystemMemory` (or a test).
 */
export function assessEmbeddingMemory(memory: SystemMemory, fileSizeGb: number): EmbeddingMemoryCheck {
  const note = lowMemoryEmbeddingNote(fileSizeGb);
  if (memory.totalBytes > 0 && memory.totalBytes < EMBEDDING_MIN_TOTAL_RAM_BYTES) {
    return { ok: false, reason: "total", note, detail: `${gb(memory.totalBytes)} RAM in total, the memory model starts from 8 GB` };
  }
  const needBytes = Math.max(EMBEDDING_MIN_AVAILABLE_RAM_BYTES, fileSizeGb * 1e9 * 2);
  if (memory.availableBytes !== null && memory.availableBytes < needBytes) {
    return { ok: false, reason: "available", note, detail: `${gb(memory.availableBytes)} available, needs ${gb(needBytes)}` };
  }
  return { ok: true };
}

/**
 * Read this machine's memory and assess it for an embedding model of
 * `fileSizeGb`. Called right before a local embedding model would start.
 * Never throws: a probe that fails says `ok`, so a broken probe never
 * costs a user with enough memory their memory model.
 */
export async function checkEmbeddingModelMemory(
  fileSizeGb: number,
  read: () => Promise<SystemMemory> = readSystemMemory,
): Promise<EmbeddingMemoryCheck> {
  try {
    return assessEmbeddingMemory(await read(), fileSizeGb);
  } catch {
    return { ok: true };
  }
}
