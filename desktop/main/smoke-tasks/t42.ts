import { totalmem } from "node:os";

import { curatedMeta } from "../model-catalog.js";
import { DENSE_KV_BYTES_PER_TOKEN, managedStart, servedWith } from "./managed-start.js";

/**
 * Release-fix checks for backlog item 42 (see main/release-fixes-smoke.ts).
 * Run alone with `--smoke --smoke-task=42`.
 *
 * 42 — On a 16 GB Mac 13.5 GB into swap, Qwen 3.5 4B started with
 * `--ctx-size 262144` "fitted from the model's KV layout": Metal reports its
 * working-set ceiling (about two thirds of RAM) as free, whatever else runs,
 * and the fit spent it. 262,144 tokens of that model's cache is 1.75 GiB at
 * turbo3, against 224 MiB at 32,768. On a device that shares the system's
 * RAM the auto context now also leaves the system a headroom of
 * max(4 GiB, a quarter of RAM) and holds the cache to 1/16 of RAM; a
 * context set in config stays as set, and a GPU with memory of its own
 * keeps the plain fit.
 *
 * The real `models start` runs against a stand-in llama-server
 * (managed-start.ts) whose `--list-devices` answers with a Metal device, then
 * a discrete card, both reporting the 10,922 MiB a 16 GB Mac's Metal device
 * does. The model's header is a dense one (28 KiB a token), dear enough that
 * the share shows on this machine whatever its RAM up to 64 GB; the expected
 * sizes are worked out here from this machine's RAM, by the rule the agent
 * uses (src/local-llm/context-size.ts).
 */

type Check = (name: string, ok: boolean, detail?: string) => void;

const MIB = 1024 * 1024;
const FREE_MIB = 10_922;
const q = (v: unknown) => JSON.stringify(v);

/** `estimateContextSize` for the dense header, from a KV budget in MiB. */
function contextFor(budgetMiB: number): number {
  const fit = budgetMiB > 0 ? Math.floor((budgetMiB * MIB) / DENSE_KV_BYTES_PER_TOKEN) : 0;
  const clamped = Math.min(262_144, Math.max(32_768, Math.min(fit, 262_144)));
  return Math.max(1024, Math.floor(clamped / 1024) * 1024);
}

export async function checks42(_js: unknown, check: Check): Promise<void> {
  const ramMiB = totalmem() / MIB;
  const weightsMiB = ((curatedMeta("qwen-3.5-4b")?.sizeGb ?? 2.7) * 1e9) / MIB;
  const fitMiB = FREE_MIB * 0.92 - weightsMiB - 768;
  const shareMiB = Math.min(ramMiB - Math.max(4096, ramMiB * 0.25) - weightsMiB - 768, ramMiB / 16);
  const expectCard = contextFor(fitMiB);
  const expectMac = contextFor(Math.min(fitMiB, shareMiB));
  const gb = Math.round(ramMiB / 1024);

  const h = await managedStart("dense");
  try {
    h.devices(`MTL0: Apple M4 (${FREE_MIB} MiB, ${FREE_MIB} MiB free)`);
    const mac = await h.start();
    const macCtx = Number(servedWith(h.calls())?.ctx ?? NaN);
    const macLog = h.log();
    await h.stop();

    h.clearCalls();
    h.devices(`CUDA0: NVIDIA GeForce RTX 4090 (24564 MiB, ${FREE_MIB} MiB free)`);
    const card = await h.start();
    const cardCtx = Number(servedWith(h.calls())?.ctx ?? NaN);
    await h.stop();

    h.clearCalls();
    h.devices(`MTL0: Apple M4 (${FREE_MIB} MiB, ${FREE_MIB} MiB free)`);
    h.managed({ contextSize: 262_144 });
    const pinned = await h.start();
    const pinnedCtx = Number(servedWith(h.calls())?.ctx ?? NaN);
    await h.stop();

    const capped = expectMac < expectCard;
    check(
      `T42: on unified memory the auto context is held to this ${gb} GB machine's RAM — ${expectMac} tokens where the GPU's free figure alone would fit ${expectCard}`,
      mac.ok && macCtx === expectMac && (!capped || /held to \d+ GB of unified memory/.test(macLog)),
      q({ ok: mac.ok, ctx: macCtx, expected: expectMac, fit: expectCard, ramMiB, launch: macLog.split("\n").filter((l) => l.includes("--ctx-size")).pop(), error: mac.error, stderr: mac.stderr.slice(-300) }),
    );
    check(
      "T42: a GPU with memory of its own keeps the plain memory fit",
      card.ok && cardCtx === expectCard,
      q({ ok: card.ok, ctx: cardCtx, expected: expectCard, error: card.error }),
    );
    check(
      "T42: a context set in config (262,144) stays as set on unified memory",
      pinned.ok && pinnedCtx === 262_144,
      q({ ok: pinned.ok, ctx: pinnedCtx, error: pinned.error }),
    );
  } finally {
    await h.dispose();
  }
}
