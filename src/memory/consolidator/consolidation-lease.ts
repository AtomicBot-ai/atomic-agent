/**
 * ATO-2506. How long the consolidator holds the lease on a cluster's
 * notes. The lease must outlive the distill call, or it expires while
 * the model is still answering and the reflection-side neighbor-evolver
 * starts changing tags on notes that are about to be archived. So it is
 * the distill timeout plus a margin, and never under the old fixed 60 s.
 */
export const MIN_CONSOLIDATION_LEASE_MS = 60_000;
export const CONSOLIDATION_LEASE_MARGIN_MS = 15_000;

export function consolidationLeaseMs(distillTimeoutMs: number): number {
  const timeout =
    Number.isFinite(distillTimeoutMs) && distillTimeoutMs > 0
      ? distillTimeoutMs
      : 0;
  return Math.max(
    MIN_CONSOLIDATION_LEASE_MS,
    timeout + CONSOLIDATION_LEASE_MARGIN_MS,
  );
}
