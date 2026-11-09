import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pluginsRoot } from "./plugin-store.js";

/**
 * Added marketplaces, shared by the terminal and the desktop:
 *
 *   plugins/marketplaces.json          lock file: source, ref, pinned commit, when fetched
 *   plugins/marketplaces/<name>/       shallow checkout (or the downloaded marketplace.json)
 *
 * A local-folder marketplace is read in place and has no checkout.
 */

/** What the user gave to `marketplace add`. */
export type MarketplaceSourceRecord =
  | { kind: "github"; repo: string }
  | { kind: "git"; url: string }
  | { kind: "local"; path: string }
  | { kind: "url"; url: string };

export interface MarketplaceRecord {
  name: string;
  source: MarketplaceSourceRecord;
  /** Branch or tag asked for with `--ref`; absent means the default branch. */
  ref?: string;
  /** Commit the checkout is pinned to (git sources only). */
  sha?: string;
  /** Marketplace file inside the checkout or folder, e.g. `.claude-plugin/marketplace.json`. */
  manifestPath: string;
  addedAt: string;
  fetchedAt: string;
}

export interface MarketplaceLockFile {
  version: 1;
  marketplaces: Record<string, MarketplaceRecord>;
}

export function marketplacesRoot(stateDir: string): string {
  return join(pluginsRoot(stateDir), "marketplaces");
}

export function marketplaceCheckoutDir(stateDir: string, name: string): string {
  return join(marketplacesRoot(stateDir), name);
}

function lockFile(stateDir: string): string {
  return join(pluginsRoot(stateDir), "marketplaces.json");
}

/** A missing or broken lock file reads as "no marketplaces"; it never stops the agent. */
export function readMarketplaceLock(stateDir: string): MarketplaceLockFile {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(lockFile(stateDir), "utf8")); } catch { return { version: 1, marketplaces: {} }; }
  const out: MarketplaceLockFile = { version: 1, marketplaces: {} };
  const list = raw && typeof raw === "object" ? (raw as { marketplaces?: unknown }).marketplaces : undefined;
  if (list && typeof list === "object" && !Array.isArray(list)) {
    for (const [name, rec] of Object.entries(list as Record<string, unknown>)) {
      const r = rec as Partial<MarketplaceRecord> | null;
      if (r && typeof r === "object" && typeof r.name === "string" && r.source && typeof r.manifestPath === "string") {
        out.marketplaces[name] = r as MarketplaceRecord;
      }
    }
  }
  return out;
}

/** Atomic write (tmp + rename), owner-only. */
export function writeMarketplaceLock(stateDir: string, lock: MarketplaceLockFile): void {
  mkdirSync(pluginsRoot(stateDir), { recursive: true });
  const file = lockFile(stateDir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** Short human description of where a marketplace comes from. */
export function describeMarketplaceSource(source: MarketplaceSourceRecord): string {
  switch (source.kind) {
    case "github": return source.repo;
    case "git": return source.url;
    case "local": return source.path;
    case "url": return source.url;
  }
}
