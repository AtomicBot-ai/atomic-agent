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
 * Smallest total RAM that starts the memory model. Under it the chat
 * model already competes with the system for every gigabyte. The floor is
 * 6 GiB, not 8: an 8 GB laptop that reserves 1-2 GB for integrated
 * graphics reports about 6-7 GiB and should keep the model. The available
 * memory check below covers the machines in between.
 */
export const EMBEDDING_MIN_TOTAL_RAM_BYTES = 6 * GIB;

/**
 * Smallest available memory that starts the memory model: the model
 * itself (about 300 MB for EmbeddingGemma 2) plus headroom for the
 * llama.cpp process and the system. A larger model needs twice its file
 * size when that is more.
 */
export const EMBEDDING_MIN_AVAILABLE_RAM_BYTES = 1 * GIB;

/**
 * Memory a chat model takes beyond its file while it loads (KV cache,
 * compute buffers), counted when the chat model starts in the same launch
 * as the memory model and so is not in the measured figure yet.
 */
export const CHAT_MODEL_LOAD_HEADROOM_BYTES = 0.5 * GIB;

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

/** Gigabytes (GiB, as the system reports them) to one decimal, without a trailing `.0`. */
function gbFigure(bytes: number): string {
  return String(Math.round((bytes / GIB) * 10) / 10);
}

function gb(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GB`;
}

/** Available memory the memory model of `fileSizeGb` needs: the real threshold the check applies. */
export function embeddingAvailableNeedBytes(fileSizeGb: number): number {
  return Math.max(EMBEDDING_MIN_AVAILABLE_RAM_BYTES, fileSizeGb * 1e9 * 2);
}

/**
 * Whether `memory` leaves room for an embedding model of `fileSizeGb`.
 * `reserveBytes` is memory about to be taken by a chat model that starts
 * in the same launch and is not in the measured figure yet. The note
 * names the threshold that decided. Pure: the figures come from
 * `readSystemMemory` (or a test).
 */
export function assessEmbeddingMemory(
  memory: SystemMemory,
  fileSizeGb: number,
  reserveBytes = 0,
): EmbeddingMemoryCheck {
  if (memory.totalBytes > 0 && memory.totalBytes < EMBEDDING_MIN_TOTAL_RAM_BYTES) {
    const floor = gbFigure(EMBEDDING_MIN_TOTAL_RAM_BYTES);
    return {
      ok: false,
      reason: "total",
      note: `Memory search uses keywords: this machine has ${gbFigure(memory.totalBytes)} GB of memory; the memory model needs at least ${floor} GB.`,
      detail: `${gb(memory.totalBytes)} RAM in total, the memory model starts from ${floor} GB`,
    };
  }
  const needBytes = embeddingAvailableNeedBytes(fileSizeGb);
  if (memory.availableBytes !== null && memory.availableBytes - reserveBytes < needBytes) {
    const beside = reserveBytes > 0 ? " beside the chat model" : "";
    return {
      ok: false,
      reason: "available",
      note: `Memory search uses keywords: not enough free memory for the memory model${beside} (needs ~${gbFigure(needBytes)} GB free).`,
      detail: reserveBytes > 0
        ? `${gb(memory.availableBytes)} available, ${gb(reserveBytes)} of it for the chat model now starting, needs ${gb(needBytes)}`
        : `${gb(memory.availableBytes)} available, needs ${gb(needBytes)}`,
    };
  }
  return { ok: true };
}

/** Memory a chat model with a file of `fileSizeGb` takes once loaded: the file plus load headroom. */
export function chatModelReserveBytes(fileSizeGb: number): number {
  return Math.max(0, fileSizeGb) * 1e9 + CHAT_MODEL_LOAD_HEADROOM_BYTES;
}

/**
 * Read this machine's memory and assess it for an embedding model of
 * `fileSizeGb`. Called right before a local embedding model would start;
 * when a chat model starts in the same launch, pass its file size as
 * `chatModelGb` so the memory it is about to take is counted. Never
 * throws: a probe that fails says `ok`, so a broken probe never costs a
 * user with enough memory their memory model.
 */
export async function checkEmbeddingModelMemory(
  fileSizeGb: number,
  opts: { chatModelGb?: number; read?: () => Promise<SystemMemory> } = {},
): Promise<EmbeddingMemoryCheck> {
  try {
    const reserve = opts.chatModelGb !== undefined ? chatModelReserveBytes(opts.chatModelGb) : 0;
    return assessEmbeddingMemory(await (opts.read ?? readSystemMemory)(), fileSizeGb, reserve);
  } catch {
    return { ok: true };
  }
}
