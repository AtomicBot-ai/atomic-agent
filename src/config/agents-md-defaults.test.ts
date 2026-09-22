import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ENV_DEFAULTS, USER_CONFIG_DEFAULTS } from "./config-schema.js";

/**
 * The prose docs quote the shipped default of most config keys inline —
 * `` `some.key` (default `value`) `` in AGENTS.md, one row per key in
 * `MEMORY_FABRIC_V2.md` §10. Those numbers are the ones a reader reasons
 * with, and nothing kept them honest: a whole class of them had drifted
 * from the code, some by two orders of magnitude
 * (`memory.voting.eventLogMaxRows` documented as 2000, shipped 50_000).
 *
 * This walks every such claim and compares it with the value the code
 * actually ships. It judges claims it can read unambiguously — a number,
 * a boolean, `null`, or a quoted string — and leaves prose forms like
 * ``(default `30 days`)`` to the reader.
 *
 * Two defaults tables exist and both are in scope: `USER_CONFIG_DEFAULTS`
 * (the `config.json` surface) and `ENV_DEFAULTS` (env-only operational
 * knobs — `agent.maxParallelToolCalls`, the loop-breaker ladder, every
 * `tasks.*` key). A documented key that resolves in neither is **not**
 * silently skipped: it must appear in `UNRESOLVED_ALLOWLIST` below, so
 * renaming a config key makes this test fail instead of quietly shrinking
 * its own coverage.
 */
const ROOT = new URL("../../", import.meta.url);
const AGENTS_MD = fileURLToPath(new URL("AGENTS.md", ROOT));
const MEMORY_FABRIC_MD = fileURLToPath(new URL("MEMORY_FABRIC_V2.md", ROOT));

/**
 * The claim forms the docs actually use. Each captures `key` then the
 * documented value:
 *   1. `` `key` (default `value`) ``      — the dominant form
 *   2. `` `key` (default value) ``        — same, value not backticked
 *   3. `` `key` — default `value` ``      — the §"Configuration (agent.*)" list
 *   4. `| `key` | `value` | …`            — the MEMORY_FABRIC_V2.md §10 table
 *
 * A bare `` `key=value` `` is deliberately **not** a form: in these docs
 * that spelling overwhelmingly means "when set to value", not "the
 * default is value" (AGENTS.md says `memory.links.enabled=true` in one
 * place and `memory.links.enabled=false` in another, describing two
 * different situations). Claims that need covering are written in one of
 * the four forms above instead.
 */
const CLAIM_FORMS: readonly RegExp[] = [
  /`([A-Za-z0-9_.]+)` \(default `([^`]*)`/g,
  /`([A-Za-z0-9_.]+)` \(default ([^`(),]+)[,)]/g,
  /`([A-Za-z0-9_.]+)` — default `([^`]*)`/g,
  /^\| `([A-Za-z0-9_.]+)` \| `([^`]*)` \|/g,
];

/**
 * Documented keys that live in neither defaults table, with the reason.
 * The skip is deliberate and visible: the assertion below is set
 * equality, so a key that leaves this list (renamed in the schema) or one
 * that is no longer documented both fail loudly.
 */
const UNRESOLVED_ALLOWLIST: readonly string[] = [
  // `LinkStore.expand`'s own parameter default (50), not a config key —
  // AGENTS.md names the runtime-config default (12) in the same breath.
  "maxExpanded",
  // `ProviderFallbackChain` timing, `DEFAULT_FALLBACK_TIMING` in
  // src/llm/fallback/fallback-config.ts — not a user-config key.
  "failureThreshold",
];

const ENV_KEY_BY_DOC_KEY: Readonly<Record<string, keyof typeof ENV_DEFAULTS>> =
  {
    "agent.maxParallelToolCalls": "MAX_PARALLEL_TOOL_CALLS",
    "agent.batchToolResultCharCap": "BATCH_TOOL_RESULT_CHAR_CAP",
    "agent.loopWarningThreshold": "LOOP_WARNING_THRESHOLD",
    "agent.loopCriticalThreshold": "LOOP_CRITICAL_THRESHOLD",
    "agent.loopBreakerVetoStreak": "LOOP_BREAKER_VETO_STREAK",
    "agent.loopHistorySize": "LOOP_HISTORY_SIZE",
    "agent.loopWanderingThreshold": "LOOP_WANDERING_THRESHOLD",
    "agent.loopWanderingEscalation": "LOOP_WANDERING_ESCALATION",
    "llama.completionRetries": "COMPLETION_RETRIES",
    "llama.completionRetryBackoffMs": "COMPLETION_RETRY_BACKOFF_MS",
    "tasks.enabled": "TASKS_ENABLED",
    "tasks.maxAttempts": "TASKS_MAX_ATTEMPTS",
    "tasks.backoffInitialMs": "TASKS_BACKOFF_INITIAL_MS",
    "tasks.backoffMaxMs": "TASKS_BACKOFF_MAX_MS",
    "tasks.runOnCreate": "TASKS_RUN_ON_CREATE",
    "tasks.staleAfterMs": "TASKS_STALE_AFTER_MS",
    "tasks.schedulerEnabled": "TASKS_SCHEDULER_ENABLED",
    "tasks.schedulerTickMs": "TASKS_SCHEDULER_TICK_MS",
    "tasks.schedulerBatch": "TASKS_SCHEDULER_BATCH",
    "tasks.agentToolsEnabled": "TASKS_AGENT_TOOLS_ENABLED",
    "tasks.minIntervalMs": "TASKS_MIN_INTERVAL_MS",
  };

/** The shipped value, or `undefined` when the key resolves in neither table. */
function resolve(path: string): unknown {
  // The docs spell env-only keys both bare (`tasks.schedulerTickMs`) and
  // qualified (`config.tasks.schedulerTickMs`); they are one key.
  const key = path.startsWith("config.") ? path.slice("config.".length) : path;
  const envKey = ENV_KEY_BY_DOC_KEY[key];
  if (envKey !== undefined) return ENV_DEFAULTS[envKey];
  let cur: unknown = USER_CONFIG_DEFAULTS;
  for (const part of key.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur === undefined ? undefined : cur;
}

/** The documented value, or `undefined` when it is prose we cannot judge. */
function parseClaim(raw: string): string | number | boolean | null | undefined {
  const text = raw.trim();
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null") return null;
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    return text.slice(1, -1);
  }
  const numeric = text.replace(/_/g, "");
  if (/^-?\d+(\.\d+)?$/.test(numeric)) return Number(numeric);
  return undefined;
}

interface Claim {
  readonly where: string;
  readonly key: string;
  readonly documented: string;
}

function collect(file: string, label: string): Claim[] {
  const claims: Claim[] = [];
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, index) => {
      for (const form of CLAIM_FORMS) {
        for (const match of line.matchAll(form)) {
          claims.push({
            where: `${label}:${index + 1}`,
            key: match[1]!,
            documented: match[2]!,
          });
        }
      }
    });
  return claims;
}

/**
 * Floor on how many claims the walk judges. Measured, not guessed: raise
 * it when documenting more defaults. It exists so a heading rename, a
 * moved file or a narrowed regex cannot make this test pass vacuously.
 */
const MIN_CHECKED = 140;

describe("documented config defaults", () => {
  it("match the shipped defaults tables", () => {
    const claims = [
      ...collect(AGENTS_MD, "AGENTS.md"),
      ...collect(MEMORY_FABRIC_MD, "MEMORY_FABRIC_V2.md"),
    ];
    const mismatches: string[] = [];
    let checked = 0;
    for (const { where, key, documented } of claims) {
      const claimed = parseClaim(documented);
      if (claimed === undefined) continue;
      const actual = resolve(key);
      if (actual === undefined || typeof actual === "object") continue;
      checked += 1;
      if (claimed !== actual) {
        mismatches.push(
          `${where} ${key} documented ${documented}, ships ${String(actual)}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
    expect(checked).toBeGreaterThanOrEqual(MIN_CHECKED);
  });

  it("documents no key that has been renamed out of the schema", () => {
    const claims = [
      ...collect(AGENTS_MD, "AGENTS.md"),
      ...collect(MEMORY_FABRIC_MD, "MEMORY_FABRIC_V2.md"),
    ];
    const unresolved = new Set<string>();
    for (const { key, documented } of claims) {
      // Only a claim we could actually read counts: prose like
      // ``(default `30 days`)`` says nothing about whether the key exists.
      if (parseClaim(documented) === undefined) continue;
      if (resolve(key) === undefined) unresolved.add(key);
    }
    expect([...unresolved].sort()).toEqual([...UNRESOLVED_ALLOWLIST].sort());
  });
});
