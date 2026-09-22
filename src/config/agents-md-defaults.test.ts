import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { USER_CONFIG_DEFAULTS } from "./config-schema.js";

/**
 * AGENTS.md documents the shipped default of most config keys inline, as
 * `` `some.key` (default `value`) ``. Those numbers are the ones a reader
 * reasons with, and nothing kept them honest: twelve of them had drifted
 * from `USER_CONFIG_DEFAULTS`, some by two orders of magnitude
 * (`memory.voting.eventLogMaxRows` documented as 2000, shipped 50_000).
 *
 * This walks every such claim and compares it with the value the code
 * actually ships. It only judges claims it can read unambiguously — a
 * number, a boolean, or a quoted string. Prose forms like ``(default
 * `30 days`)`` are left to the reader, as is any key that does not
 * resolve in `USER_CONFIG_DEFAULTS` (a derived or per-provider default).
 */
const AGENTS_MD = fileURLToPath(new URL("../../AGENTS.md", import.meta.url));

const CLAIM_RE = /`([A-Za-z0-9_.]+)` \(default `([^`]*)`/g;

function resolve(path: string): unknown {
  let cur: unknown = USER_CONFIG_DEFAULTS;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** The documented value, or `undefined` when it is prose we cannot judge. */
function parseClaim(raw: string): string | number | boolean | undefined {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    return raw.slice(1, -1);
  }
  const numeric = raw.replace(/_/g, "");
  if (/^-?\d+(\.\d+)?$/.test(numeric)) return Number(numeric);
  return undefined;
}

describe("AGENTS.md documented defaults", () => {
  it("match USER_CONFIG_DEFAULTS", () => {
    const lines = readFileSync(AGENTS_MD, "utf8").split("\n");
    const mismatches: string[] = [];
    let checked = 0;
    lines.forEach((line, index) => {
      for (const match of line.matchAll(CLAIM_RE)) {
        const [, key, documented] = match;
        const actual = resolve(key!);
        if (actual === undefined || typeof actual === "object") continue;
        const claimed = parseClaim(documented!);
        if (claimed === undefined) continue;
        checked += 1;
        if (claimed !== actual) {
          mismatches.push(
            `AGENTS.md:${index + 1} ${key} documented ${documented}, ships ${String(actual)}`,
          );
        }
      }
    });
    // Guard against the check silently reading nothing (a heading rename,
    // a moved file) and passing vacuously.
    expect(checked).toBeGreaterThan(40);
    expect(mismatches).toEqual([]);
  });
});
