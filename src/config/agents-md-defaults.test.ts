import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ENV_DEFAULTS, USER_CONFIG_DEFAULTS } from "./config-schema.js";

/**
 * The prose docs quote the shipped default of most config keys inline —
 * `` `some.key` (default `value`) `` in AGENTS.md, one row per key in
 * `MEMORY_FABRIC_V2.md` §10, `` Default `value` `` in config-schema.ts's
 * own JSDoc. Those numbers are the ones a reader reasons with, and
 * nothing kept them honest: a whole class of them had drifted from the
 * code, some by two orders of magnitude
 * (`memory.voting.eventLogMaxRows` documented as 2000, shipped 50_000).
 *
 * This walks every claim it can read unambiguously — a number, a
 * boolean, `null`, a quoted string, or a duration with a unit — and
 * compares it with the value the code ships.
 *
 * Two defaults tables are in scope and both are checked:
 * `USER_CONFIG_DEFAULTS` (the `config.json` surface) and `ENV_DEFAULTS`
 * (env-only operational knobs — `agent.maxParallelToolCalls`, the
 * loop-breaker ladder, every `tasks.*` key). A documented key that
 * resolves in neither is **not** silently skipped: for the two markdown
 * files it must appear in `UNRESOLVED_ALLOWLIST`, so renaming a config
 * key makes this test fail instead of quietly shrinking its own
 * coverage.
 */
const ROOT = new URL("../../", import.meta.url);
const AGENTS_MD = fileURLToPath(new URL("AGENTS.md", ROOT));
const MEMORY_FABRIC_MD = fileURLToPath(new URL("MEMORY_FABRIC_V2.md", ROOT));
const CONFIG_SCHEMA_TS = fileURLToPath(new URL("src/config/config-schema.ts", ROOT));

/**
 * The claim forms the markdown docs actually use. Each captures `key`
 * then the documented value. `\s+` rather than a literal space
 * throughout, and the scan runs over the whole file rather than line by
 * line, so a claim wrapped across two lines is read like any other.
 *
 *   1. `` `key` (default `value`) ``      — the dominant form
 *   2. `` `key` (default value) ``        — same, value not backticked
 *   3. `` `key` — default `value` ``      — the §"Configuration (agent.*)" list
 *   4. `` `key` (1..8, default value …) `` — a range or note before the default
 *   5. `` | `key` | `value` | `` …        — the MEMORY_FABRIC_V2.md §10 table
 *
 * A bare `` `key=value` `` is deliberately **not** a form. In these docs
 * that spelling overwhelmingly means "when set to value", not "the
 * default is value" (AGENTS.md says `memory.links.enabled=true` in one
 * place and `memory.links.enabled=false` in another, describing two
 * different situations). Claims that need covering are written in one of
 * the five forms above instead.
 *
 * `` (proposed default `x`) `` is deliberately **not** a form either:
 * `MEMORY_FABRIC_V2.md` §6 is the original design proposal and says what
 * was *proposed*, which is a claim about that document's own history,
 * not about what ships.
 */
const CLAIM_FORMS: readonly RegExp[] = [
  /`([A-Za-z0-9_.]+)`\s+\(default\s+`([^`]*)`/g,
  /`([A-Za-z0-9_.]+)`\s+\(default\s+([^`(),]+?)\s*[,)]/g,
  /`([A-Za-z0-9_.]+)`\s+—\s+default\s+`([^`]*)`/g,
  /`([A-Za-z0-9_.]+)`\s+\((?!default)[^`()]{1,60}?,\s+default\s+`?([^`()\s,]+?)`?[\s,)]/g,
  /^\|\s*`([A-Za-z0-9_.]+)`\s*\|\s*`([^`]*)`\s*\|/gm,
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
  // Fusion run-mode fan-out width. `llm.*` is a separate config file
  // (`llm.json`, parsed by src/config/llm-config.ts +
  // llm-run-mode-config.ts) with no single defaults table to compare
  // against — every key defaults at its own read site. Out of scope
  // here rather than silently skipped; see UNRESOLVED_PREFIXES.
  "workers",
];

/**
 * Whole config surfaces this test does not resolve, so a key under one
 * never reaches `UNRESOLVED_ALLOWLIST`. `llm.*` is the only one: it is a
 * separate file with per-read-site defaults rather than a defaults
 * object, so pinning it needs a resolver of its own, not an entry here.
 */
const UNRESOLVED_PREFIXES: readonly string[] = ["llm."];

const ENV_KEY_BY_DOC_KEY: Readonly<Record<string, keyof typeof ENV_DEFAULTS>> =
  {
    "agent.maxParallelToolCalls": "MAX_PARALLEL_TOOL_CALLS",
    "agent.batchToolResultCharCap": "BATCH_TOOL_RESULT_CHAR_CAP",
    "agent.shellToolResultCharCap": "SHELL_TOOL_RESULT_CHAR_CAP",
    "agent.shellToolResultTailLines": "SHELL_TOOL_RESULT_TAIL_LINES",
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

/** Sentinel for "this key resolves nowhere", distinct from a shipped `undefined`. */
const UNRESOLVED = Symbol("unresolved");

/** The shipped value, or `UNRESOLVED`. */
function resolve(path: string): unknown {
  // The docs spell env-only keys both bare (`tasks.schedulerTickMs`) and
  // qualified (`config.tasks.schedulerTickMs`); they are one key.
  const key = path.startsWith("config.") ? path.slice("config.".length) : path;
  const envKey = ENV_KEY_BY_DOC_KEY[key];
  if (envKey !== undefined) return ENV_DEFAULTS[envKey];
  let cur: unknown = USER_CONFIG_DEFAULTS;
  for (const part of key.split(".")) {
    if (cur === null || typeof cur !== "object") return UNRESOLVED;
    if (!(part in (cur as Record<string, unknown>))) return UNRESOLVED;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur === undefined ? UNRESOLVED : cur;
}

const MS_PER_UNIT: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  sec: 1_000,
  min: 60_000,
  h: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
};

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
  // Durations the docs write in human units: `30 days`, `6h`, `150ms`.
  const withUnit = numeric.match(/^(\d+(?:\.\d+)?)\s*([A-Za-z]+)$/);
  if (withUnit) {
    const factor = MS_PER_UNIT[withUnit[2]!.toLowerCase()];
    if (factor !== undefined) return Number(withUnit[1]) * factor;
  }
  return undefined;
}

interface Claim {
  readonly where: string;
  readonly key: string;
  readonly documented: string;
}

/** Line number (1-based) of a character offset in `text`. */
function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i += 1) if (text[i] === "\n") line += 1;
  return line;
}

function collectMarkdown(file: string, label: string): Claim[] {
  const text = readFileSync(file, "utf8");
  const claims: Claim[] = [];
  for (const form of CLAIM_FORMS) {
    for (const match of text.matchAll(form)) {
      claims.push({
        where: `${label}:${lineAt(text, match.index)}`,
        key: match[1]!,
        documented: match[2]!,
      });
    }
  }
  return claims;
}

/**
 * config-schema.ts documents the same defaults a third time, in the
 * JSDoc above each config block, and those comments drifted exactly like
 * the markdown did (eleven sites said ``Default `false` `` / "Default
 * disabled" for switches that ship `true`).
 *
 * Keys there are written bare (`` `recallK` ``), so they are resolved
 * against the block the comment belongs to: the declaration that follows
 * it, or the most recent `` `<block>` keys: `` header inside it. The
 * resulting `owner.key` must match exactly one path in
 * `USER_CONFIG_DEFAULTS` — an ambiguous or unknown one is skipped rather
 * than guessed, because this file also documents plenty that is not
 * user config. That is why there is no set-equality assertion for this
 * source; `MIN_CHECKED_SCHEMA` is what stops the coverage shrinking.
 */
const SCHEMA_CLAIM = /`([A-Za-z0-9_]+)`[^`]{0,200}?[Dd]efault\s+`([^`]*)`/g;
const SCHEMA_SECTION = /`([A-Za-z0-9_.]+)`\s+keys:/g;
/** Prose spellings of a boolean master-switch default. */
const SCHEMA_PROSE_OFF = /Default\s+disabled|[Dd]isabled\s+by\s+default/g;
const SCHEMA_PROSE_ON = /[Ee]nabled\s+by\s+default/g;

const PATHS_BY_SUFFIX = ((): Map<string, string[]> => {
  const index = new Map<string, string[]>();
  const walk = (node: unknown, path: string): void => {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return;
    for (const [key, value] of Object.entries(node)) {
      const next = path ? `${path}.${key}` : key;
      const suffix = next.split(".").slice(-2).join(".");
      index.set(suffix, [...(index.get(suffix) ?? []), next]);
      walk(value, next);
    }
  };
  walk(USER_CONFIG_DEFAULTS, "");
  return index;
})();

/** The one path ending in `owner.key`, or undefined when 0 or >1 match. */
function resolveBySuffix(suffix: string): string | undefined {
  const hits = PATHS_BY_SUFFIX.get(suffix);
  return hits?.length === 1 ? hits[0] : undefined;
}

function collectSchemaJsdoc(): Claim[] {
  const lines = readFileSync(CONFIG_SCHEMA_TS, "utf8").split("\n");
  const claims: Claim[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!/^\s*\/\*\*/.test(lines[index]!)) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < lines.length && !/\*\//.test(lines[index]!)) index += 1;
    const end = index;
    index += 1;
    // The declaration the block documents, skipping blank / `//` lines.
    let next = index;
    while (next < lines.length && /^\s*(\/\/|$)/.test(lines[next]!)) next += 1;
    const declared = lines[next]?.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*:/);
    // Join the block so a claim wrapped across ` * ` lines reads whole,
    // keeping a per-character map back to the source line.
    let body = "";
    const lineOf: number[] = [];
    for (let l = start; l <= end; l += 1) {
      const stripped = lines[l]!.replace(/^\s*\/?\*+\/?/, "") + " ";
      for (let c = 0; c < stripped.length; c += 1) lineOf.push(l + 1);
      body += stripped;
    }
    const sections = [...body.matchAll(SCHEMA_SECTION)].map((m) => ({
      at: m.index,
      owner: m[1]!.split(".").slice(-1)[0]!,
    }));
    const ownerAt = (at: number): string | undefined => {
      let owner = declared?.[1];
      for (const section of sections) if (section.at < at) owner = section.owner;
      return owner;
    };
    const push = (at: number, key: string, documented: string): void => {
      const owner = ownerAt(at);
      if (owner === undefined) return;
      const path = resolveBySuffix(`${owner}.${key}`);
      if (path === undefined) return;
      claims.push({
        where: `config-schema.ts:${lineOf[at] ?? start + 1}`,
        key: path,
        documented,
      });
    };
    for (const m of body.matchAll(SCHEMA_CLAIM)) push(m.index, m[1]!, m[2]!);
    for (const m of body.matchAll(SCHEMA_PROSE_OFF)) push(m.index, "enabled", "false");
    for (const m of body.matchAll(SCHEMA_PROSE_ON)) push(m.index, "enabled", "true");
  }
  return claims;
}

/**
 * Floors on how many claims each source contributes. Measured, not
 * guessed: raise them when documenting more defaults. They exist so a
 * heading rename, a moved file or a narrowed regex cannot make this test
 * pass vacuously.
 */
const MIN_CHECKED_MARKDOWN = 168;
const MIN_CHECKED_SCHEMA = 23;

function judge(claims: readonly Claim[]): {
  mismatches: string[];
  checked: number;
} {
  const mismatches: string[] = [];
  let checked = 0;
  for (const { where, key, documented } of claims) {
    const claimed = parseClaim(documented);
    if (claimed === undefined) continue;
    const actual = resolve(key);
    if (actual === UNRESOLVED) continue;
    if (typeof actual === "object" && actual !== null) continue;
    checked += 1;
    if (claimed !== actual) {
      mismatches.push(
        `${where} ${key} documented ${documented}, ships ${String(actual)}`,
      );
    }
  }
  return { mismatches, checked };
}

const markdownClaims = (): Claim[] => [
  ...collectMarkdown(AGENTS_MD, "AGENTS.md"),
  ...collectMarkdown(MEMORY_FABRIC_MD, "MEMORY_FABRIC_V2.md"),
];

describe("documented config defaults", () => {
  it("match the shipped defaults tables", () => {
    const { mismatches, checked } = judge(markdownClaims());
    expect(mismatches).toEqual([]);
    expect(checked).toBeGreaterThanOrEqual(MIN_CHECKED_MARKDOWN);
  });

  it("match the JSDoc in config-schema.ts", () => {
    const { mismatches, checked } = judge(collectSchemaJsdoc());
    expect(mismatches).toEqual([]);
    expect(checked).toBeGreaterThanOrEqual(MIN_CHECKED_SCHEMA);
  });

  it("document no key that has been renamed out of the schema", () => {
    const unresolved = new Set<string>();
    for (const { key, documented } of markdownClaims()) {
      // Only a claim we could actually read counts: prose like
      // ``(default `one per slot`)`` says nothing about whether the key exists.
      if (parseClaim(documented) === undefined) continue;
      if (UNRESOLVED_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
      if (resolve(key) === UNRESOLVED) unresolved.add(key);
    }
    expect([...unresolved].sort()).toEqual([...UNRESOLVED_ALLOWLIST].sort());
  });
});
