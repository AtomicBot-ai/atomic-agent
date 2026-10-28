import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { WebSearchProviderName } from "../web-search-provider.js";
import type { CooldownTag } from "./provider-cooldown.js";

/**
 * On-disk mirror of the rate-limit cooldown (#256). Only 429 parks are
 * written here; unreachable parks stay in the process that saw them
 * (ATO-315).
 */
export interface CooldownEntry {
  until: number;
  /** Consecutive parks, for the doubling. */
  strikes: number;
  /** Tier the park was earned on; absent for an untagged park. */
  tag?: CooldownTag;
}

export function loadCooldownFile(
  filePath: string,
  now: number,
  maxMs: number,
): Map<WebSearchProviderName, CooldownEntry> {
  const entries = new Map<WebSearchProviderName, CooldownEntry>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    // Missing on the very first run, or corrupt. A cold cooldown is the
    // pre-#256 behaviour, so it is always a safe recovery.
    return entries;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return entries;
  }
  for (const [name, raw] of Object.entries(parsed)) {
    const entry = raw as Partial<CooldownEntry> | null;
    if (
      typeof entry?.until !== "number" ||
      !Number.isFinite(entry.until) ||
      typeof entry.strikes !== "number" ||
      !Number.isFinite(entry.strikes)
    ) {
      continue;
    }
    // Strikes outlive an expired park in-process (see `park`), and they
    // survive a restart the same way — but not forever. A record whose
    // park ended more than two ceilings ago is yesterday's evidence, and
    // restoring it would restart the ladder near the top against a quota
    // that has long since reset.
    if (entry.until + 2 * maxMs <= now) continue;
    entries.set(name as WebSearchProviderName, {
      until: entry.until,
      strikes: entry.strikes,
      // Files from before tags existed have none: untagged, as before.
      ...(entry.tag === "keyless" || entry.tag === "keyed"
        ? { tag: entry.tag }
        : {}),
    });
  }
  return entries;
}

export function saveCooldownFile(
  filePath: string,
  entries: Map<WebSearchProviderName, CooldownEntry>,
): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(entries)), "utf8");
    renameSync(tmp, filePath);
  } catch {
    // Persistence is best-effort: a read-only stateDir or a full disk
    // costs the next process its warm start, never this search.
  }
}
