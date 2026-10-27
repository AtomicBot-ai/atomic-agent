import { freemem, totalmem } from "node:os";

import { stopCoreEmbedding } from "../core/core-embedding.js";

/**
 * ATO-379: on a machine with little memory the memory (embedding) model
 * is not started automatically, and memory search runs on keywords only
 * (FTS5/BM25, the path recall already takes whenever no embedding model
 * answers).
 *
 * Why these numbers. EmbeddingGemma 2 is ~310 MB of weights; with its
 * process, a 2048-token context and Atomic Core's module around it, we
 * estimate it holds roughly 0.5 GB while it runs (an estimate, not a
 * measurement). That is small next to the chat
 * model, but on a 4–6 GB machine the chat model already takes most of
 * the memory, and the extra half gigabyte is what pushes the machine
 * into swap.
 *
 * - Total RAM below 7 GiB: machines sold as "8 GB" report about 7.4–8 GiB
 *   once the firmware and integrated GPU take their share, so the line
 *   sits at 7 GiB: 8 GB machines keep memory search, 4–6 GB ones do not.
 * - Free RAM below 1.5 GiB when the start is decided (after the chat
 *   model loaded): the module's ~0.5 GB plus ~1 GiB left for the system
 *   and the chat model's working set. Checked on Linux and Windows only:
 *   macOS's `os.freemem()` counts only completely unused pages (not the
 *   cached and inactive memory the system hands back on demand), so a
 *   healthy Mac routinely reports a few hundred MB "free". On macOS the
 *   total-RAM line alone decides.
 *
 * Both lines assume a local chat model runs beside it. With none (the
 * chat route is a cloud model and only the memory model is started),
 * only a lower floor applies: total RAM under 4 GiB, no free-RAM rule.
 */
const GIB = 1024 ** 3;
export const EMBEDDING_MIN_TOTAL_RAM_BYTES = 7 * GIB;
export const EMBEDDING_MIN_FREE_RAM_BYTES = 1.5 * GIB;
/** The floor when no local chat model runs beside the memory model. */
export const EMBEDDING_ALONE_MIN_TOTAL_RAM_BYTES = 4 * GIB;

/** The one short note the user sees when the memory model is held back. */
export const LOW_MEMORY_EMBEDDING_NOTE = "Low memory: memory search uses keywords only.";

export interface HostMemory {
  platform: NodeJS.Platform;
  totalBytes: number;
  freeBytes: number;
}

export type EmbeddingMemoryVerdict =
  | { ok: true }
  | { ok: false; reason: "total-ram" | "free-ram"; totalBytes: number; freeBytes: number };

export function readHostMemory(): HostMemory {
  return { platform: process.platform, totalBytes: totalmem(), freeBytes: freemem() };
}

/**
 * Whether this machine has room for the memory model now. Pure given
 * `host`. `localChatRunning` (default true): a local chat model runs, or
 * is being started, beside it.
 */
export function checkEmbeddingMemory(
  host: HostMemory = readHostMemory(),
  opts: { localChatRunning?: boolean } = {},
): EmbeddingMemoryVerdict {
  const { totalBytes, freeBytes } = host;
  const withChat = opts.localChatRunning ?? true;
  const minTotal = withChat ? EMBEDDING_MIN_TOTAL_RAM_BYTES : EMBEDDING_ALONE_MIN_TOTAL_RAM_BYTES;
  // An unreadable figure (0 or NaN) never blocks: the gate only acts on a measured shortage.
  if (totalBytes > 0 && totalBytes < minTotal) {
    return { ok: false, reason: "total-ram", totalBytes, freeBytes };
  }
  if (withChat && host.platform !== "darwin" && freeBytes > 0 && freeBytes < EMBEDDING_MIN_FREE_RAM_BYTES) {
    return { ok: false, reason: "free-ram", totalBytes, freeBytes };
  }
  return { ok: true };
}

/**
 * The check every automatic start of the memory model goes through. Ask
 * it only when the memory model is not running already: a running one's
 * own memory is counted as used, and the turn-off below would stop a
 * working model. When
 * memory is short it also turns off an Atomic Core embedding module left
 * enabled by an earlier run: Core starts an enabled, idle module on the
 * first embed request, which would load the model anyway. Best effort; a
 * Core that is not running records the turn-off for its next start.
 */
export async function holdEmbeddingForLowMemory(
  dataDir: string,
  deps: {
    /** Default true; false when only the memory model would run (cloud chat route). */
    localChatRunning?: boolean;
    check?: () => EmbeddingMemoryVerdict;
    turnOffCoreModule?: (dataDir: string) => Promise<unknown>;
  } = {},
): Promise<EmbeddingMemoryVerdict> {
  const verdict = deps.check
    ? deps.check()
    : checkEmbeddingMemory(readHostMemory(), deps.localChatRunning === undefined ? {} : { localChatRunning: deps.localChatRunning });
  if (verdict.ok) return verdict;
  const turnOff = deps.turnOffCoreModule ?? ((dir: string) => stopCoreEmbedding(dir, { retire: false, waitMs: 5_000 }));
  await turnOff(dataDir).catch(() => undefined);
  return verdict;
}

let lowMemoryNoted = false;

/** True the first time in this process, false after: the note is shown once. */
export function claimLowMemoryEmbeddingNote(): boolean {
  if (lowMemoryNoted) return false;
  lowMemoryNoted = true;
  return true;
}

/** Tests only. */
export function resetLowMemoryEmbeddingNote(): void {
  lowMemoryNoted = false;
}
