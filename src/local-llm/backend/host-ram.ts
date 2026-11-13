/**
 * ATO-1442 — host RAM in the unit the machine is sold in. One helper for
 * every terminal surface (onboarding picks, the local-models panel, the
 * model recommendation), and the same rule the desktop uses
 * (`desktop/main/agent-cli.ts` `marketedRamGb`), so both clients give the
 * same model the same "fits / tight" verdict.
 *
 * A "16 GB" Mac reports 17.18e9 bytes, which is 16 GiB: dividing by 1e9
 * printed "17 GB" beside a box that says 16.
 */

import { totalmem } from "node:os";

/** The memory sizes machines are sold with, in GB (really GiB). */
const MARKETED_RAM_GB = [4, 6, 8, 12, 16, 18, 24, 32, 36, 48, 64, 96, 128, 192, 256, 384, 512];

/**
 * Bytes -> GiB, snapped to the nearest marketed size when it is within
 * 0.75 GiB of one (a VM or an odd machine keeps its own rounded figure).
 */
export function marketedRamGb(bytes: number): number {
  const gib = bytes / 1024 ** 3;
  if (!(gib > 0)) return 1;
  let near = MARKETED_RAM_GB[0]!;
  for (const size of MARKETED_RAM_GB) if (Math.abs(size - gib) < Math.abs(near - gib)) near = size;
  return Math.abs(near - gib) <= 0.75 ? near : Math.max(1, Math.round(gib));
}

/** This machine's RAM in whole GB as it is sold. */
export function hostRamGb(): number {
  return marketedRamGb(totalmem());
}
