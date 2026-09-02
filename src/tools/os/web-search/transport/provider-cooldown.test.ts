import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPersistentProviderCooldown,
  createProviderCooldown,
  formatCooldown,
} from "./provider-cooldown.js";

/**
 * The behaviour issue #179 asked for, stated as a schedule rather than
 * as "backoff": against a *standing* quota — 1341 429s spread evenly
 * across 24 hours — the useful move is not waiting longer between
 * retries, it is not sending the retries.
 */
describe("createProviderCooldown", () => {
  const T0 = 1_000_000;

  it("parks nothing until something is rate limited", () => {
    const cooldown = createProviderCooldown();
    expect(cooldown.isParked("exa", T0)).toBe(false);
    expect(cooldown.remainingMs("exa", T0)).toBe(0);
  });

  it("parks for a minute on the first 429", () => {
    const cooldown = createProviderCooldown();
    expect(cooldown.park("exa", T0, null)).toBe(60_000);
    expect(cooldown.isParked("exa", T0)).toBe(true);
    expect(cooldown.remainingMs("exa", T0 + 59_000)).toBe(1000);
    expect(cooldown.isParked("exa", T0 + 60_001)).toBe(false);
  });

  it("parks only the provider that was limited", () => {
    const cooldown = createProviderCooldown();
    cooldown.park("exa", T0, null);
    expect(cooldown.isParked("duckduckgo", T0)).toBe(false);
  });

  it("doubles on each consecutive 429, up to the ceiling", () => {
    const cooldown = createProviderCooldown();
    expect(cooldown.park("exa", T0, null)).toBe(60_000);
    expect(cooldown.park("exa", T0, null)).toBe(120_000);
    expect(cooldown.park("exa", T0, null)).toBe(240_000);
    expect(cooldown.park("exa", T0, null)).toBe(480_000);
    expect(cooldown.park("exa", T0, null)).toBe(900_000);
    expect(cooldown.park("exa", T0, null)).toBe(900_000);
  });

  it("keeps escalating across an expired park", () => {
    // A provider limited three times in ten minutes has a standing
    // quota whether or not its last park has lapsed. Restarting the
    // ladder at one minute each time would walk straight back into it.
    const cooldown = createProviderCooldown();
    cooldown.park("exa", T0, null);
    expect(cooldown.park("exa", T0 + 61_000, null)).toBe(120_000);
  });

  it("resets the ladder once the provider answers", () => {
    const cooldown = createProviderCooldown();
    cooldown.park("exa", T0, null);
    cooldown.park("exa", T0, null);
    cooldown.clear("exa");
    expect(cooldown.isParked("exa", T0)).toBe(false);
    expect(cooldown.park("exa", T0, null)).toBe(60_000);
  });

  it("honours a longer Retry-After than the ladder would pick", () => {
    const cooldown = createProviderCooldown();
    expect(cooldown.park("exa", T0, 300_000)).toBe(300_000);
  });

  it("ignores a Retry-After shorter than the ladder", () => {
    // Otherwise a provider answering `Retry-After: 1` on every request
    // defeats the escalation by being polite about it.
    const cooldown = createProviderCooldown();
    cooldown.park("exa", T0, null);
    expect(cooldown.park("exa", T0, 1000)).toBe(120_000);
  });

  it("clamps a Retry-After that is really a lockout", () => {
    // A day-long header would park the provider past the end of any
    // session, on one server's say-so.
    const cooldown = createProviderCooldown();
    expect(cooldown.park("exa", T0, 86_400_000)).toBe(900_000);
  });

  it("treats a negative Retry-After as no advice at all", () => {
    const cooldown = createProviderCooldown();
    expect(cooldown.park("exa", T0, -5000)).toBe(60_000);
  });
});

describe("createPersistentProviderCooldown (#256)", () => {
  const T0 = 1_000_000;
  /** Default doubling ceiling: fifteen minutes. */
  const MAX_MS = 15 * 60_000;
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "provider-cooldown-"));
    filePath = join(dir, "web-search-cooldown.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("a second process inherits a live park", () => {
    const first = createPersistentProviderCooldown({ filePath, now: () => T0 });
    first.park("exa", T0, null);

    const second = createPersistentProviderCooldown({
      filePath,
      now: () => T0 + 30_000,
    });
    expect(second.isParked("exa", T0 + 30_000)).toBe(true);
    expect(second.remainingMs("exa", T0 + 30_000)).toBe(30_000);
    expect(second.isParked("duckduckgo", T0 + 30_000)).toBe(false);
  });

  it("a park that lapsed while nothing ran reads as expired, but the strikes survive", () => {
    const first = createPersistentProviderCooldown({ filePath, now: () => T0 });
    first.park("exa", T0, null);

    // Restart after the one-minute park has lapsed: not parked, yet the
    // next 429 escalates to two minutes instead of restarting the ladder —
    // exactly the in-process "keeps escalating across an expired park"
    // semantic, now across a process boundary.
    const second = createPersistentProviderCooldown({
      filePath,
      now: () => T0 + 61_000,
    });
    expect(second.isParked("exa", T0 + 61_000)).toBe(false);
    expect(second.park("exa", T0 + 61_000, null)).toBe(120_000);
  });

  it("drops a record whose park ended more than two ceilings ago", () => {
    const first = createPersistentProviderCooldown({ filePath, now: () => T0 });
    first.park("exa", T0, null);
    first.park("exa", T0, null);

    // until = T0 + 120_000; evidence this stale is yesterday's quota.
    const later = T0 + 120_000 + 2 * MAX_MS + 1;
    const second = createPersistentProviderCooldown({
      filePath,
      now: () => later,
    });
    expect(second.isParked("exa", later)).toBe(false);
    expect(second.park("exa", later, null)).toBe(60_000);
  });

  it("clear removes the record from disk as well", () => {
    const first = createPersistentProviderCooldown({ filePath, now: () => T0 });
    first.park("exa", T0, null);
    first.park("exa", T0, null);
    first.clear("exa");

    const second = createPersistentProviderCooldown({ filePath, now: () => T0 });
    expect(second.isParked("exa", T0)).toBe(false);
    expect(second.park("exa", T0, null)).toBe(60_000);
  });

  it("starts cold on a corrupt file instead of throwing, and park repairs it", () => {
    writeFileSync(filePath, "{not json[", "utf8");
    const first = createPersistentProviderCooldown({ filePath, now: () => T0 });
    expect(first.isParked("exa", T0)).toBe(false);

    first.park("exa", T0, null);
    const second = createPersistentProviderCooldown({ filePath, now: () => T0 });
    expect(second.isParked("exa", T0)).toBe(true);
  });

  it("skips malformed entries without dropping the valid ones", () => {
    writeFileSync(
      filePath,
      JSON.stringify({
        duckduckgo: { until: "soon", strikes: 1 },
        searxng: null,
        exa: { until: T0 + 60_000, strikes: 1 },
      }),
      "utf8",
    );
    const cooldown = createPersistentProviderCooldown({
      filePath,
      now: () => T0,
    });
    expect(cooldown.isParked("exa", T0)).toBe(true);
    expect(cooldown.isParked("duckduckgo", T0)).toBe(false);
    expect(cooldown.isParked("searxng", T0)).toBe(false);
  });
});

describe("formatCooldown", () => {
  it("reads as a wait, not as a number of milliseconds", () => {
    expect(formatCooldown(45_000)).toBe("45s");
    expect(formatCooldown(60_000)).toBe("1m");
    expect(formatCooldown(90_000)).toBe("1m 30s");
    expect(formatCooldown(900_000)).toBe("15m");
    expect(formatCooldown(0)).toBe("0s");
    expect(formatCooldown(-1)).toBe("0s");
  });
});
