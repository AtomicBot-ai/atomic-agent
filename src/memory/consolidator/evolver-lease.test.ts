import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStore } from "../memory-store.js";

import { evolverLeaseMs } from "./consolidation-lease.js";
import { ConsolidatorJob } from "./consolidator-job.js";

const EVOLUTION_LEASE_MS = 60_000; // memory.evolution.leaseMs default

describe("evolverLeaseMs (ATO-2784)", () => {
  let dir: string;
  let store: MemoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-evolver-lease-"));
    store = new MemoryStore({ dbFile: join(dir, "memory.sqlite"), maxEntries: 100 });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A note under a consolidator lease taken `ageMs` before the evolve call. */
  const evolveAfter = (ageMs: number, leaseMs: number) => {
    const note = store.store({ content: "note under distill", source: "agent" }, 1_000);
    const takenAt = 10_000;
    expect(store.acquireConsolidationLease(note.id, leaseMs, takenAt)).toBe(true);
    return store.evolveTags(note.id, ["new-tag"], { leaseMs, now: takenAt + ageMs }).outcome;
  };

  it("keeps the evolver off a note 70 s into a 120 s distill", () => {
    const leaseMs = ConsolidatorJob.evolverLeaseMsFor(EVOLUTION_LEASE_MS, 120_000);
    expect(leaseMs).toBe(135_000);
    expect(evolveAfter(70_000, leaseMs)).toBe("skipped_lease_held");
  });

  it("with the bare evolution lease (the old wiring) the same note is changed", () => {
    expect(evolveAfter(70_000, EVOLUTION_LEASE_MS)).toBe("applied");
  });

  it("changes nothing for the default 45 s distill timeout", () => {
    expect(evolverLeaseMs(EVOLUTION_LEASE_MS, 45_000)).toBe(EVOLUTION_LEASE_MS);
    expect(ConsolidatorJob.evolverLeaseMsFor(EVOLUTION_LEASE_MS, 45_000)).toBe(EVOLUTION_LEASE_MS);
  });

  it("keeps a configured evolution lease that is already longer", () => {
    expect(evolverLeaseMs(600_000, 120_000)).toBe(600_000);
  });
});
