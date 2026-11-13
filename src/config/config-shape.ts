import { USER_CONFIG_DEFAULTS } from "./config-schema.js";
import type { UserLlmFallbackConfig, UserLlmFileConfig } from "./llm-config.js";
import type { UserLlmFusionConfig, UserLlmRunModeConfig } from "./llm-run-mode-config.js";

/**
 * Which object nodes of `config.json` have a field set this build knows
 * in advance, and which hold keys the user (or another client) invents.
 *
 * The desktop app and the terminal agent share one state dir (ATO-417),
 * so an older build regularly saves a file a newer build wrote. To keep
 * what the newer build added, the writer needs to know where a key it
 * has never heard of is "a setting from the future" (a `fixed` block:
 * carry it over from disk) and where it is "an entry the caller removed"
 * (a `dictionary`: the caller's data is the whole truth). See
 * `carryUnknownConfigKeys`.
 *
 * - `fixed`: the block's field names are the schema's. Every object node
 *   of `USER_CONFIG_DEFAULTS` except `webhooks` is one, and so are the
 *   root (path `""`) and the `llm` blocks below, which the defaults do
 *   not have.
 * - `dictionary`: names or entries are user data — `webhooks` (keyed by
 *   binding name), `mcp.servers` and `llm.providers` (lists of named
 *   entries). Arrays are always whole values, and so is everything
 *   inside a list entry (`providerPreferences`, `extraBody`, `params`).
 *
 * Both lists are explicit on purpose: the guard test walks every object
 * node of the defaults and fails when one is in neither, so a new block
 * cannot land without someone deciding which kind it is.
 */
export type ConfigBranchKind = "fixed" | "dictionary";

export const FIXED_CONFIG_BRANCHES: ReadonlySet<string> = new Set([
  "",
  "localModels",
  "localModels.managed",
  "localModels.embeddings",
  "localModels.download",
  "log",
  "agent",
  "agent.providerWait",
  "agent.task",
  "agent.compaction",
  "agent.prompt",
  "agent.tools",
  "http",
  "web",
  "web.search",
  "web.search.searxng",
  "web.search.exa",
  "web.search.brave",
  "web.fetch",
  "projects",
  "tools",
  "tools.shell",
  "browser",
  "tools.screen",
  "sessions",
  "sessions.retention",
  "tracing",
  "tracing.trace",
  "memory",
  "memory.profile",
  "memory.reflection",
  "memory.reflection.typedNotes",
  "memory.reflection.segmentation",
  "memory.notes",
  "memory.recallInjection",
  "memory.index",
  "memory.dedup",
  "memory.eviction",
  "memory.embeddings",
  "memory.links",
  "memory.evolution",
  "memory.lessons",
  "memory.procedures",
  "memory.consolidation",
  "memory.voting",
  "memory.retrieve",
  "memory.retrieve.rewriter",
  "memory.retrieve.rewriter.embeddingGate",
  "vision",
  "skills",
  "skills.clawhub",
  "tui",
  "tui.notify",
  "tui.sessionRail",
  "tui.onboarding",
  "analytics",
  "telegram",
  "discord",
  "swarm",
  "notifications",
  "notifications.downloads",
  "atomicMail",
  "git",
  "composio",
  "mcp",
  "llm",
  "llm.fallback",
  "llm.runMode",
  "llm.runMode.fusion",
]);

export const DICTIONARY_CONFIG_BRANCHES: ReadonlySet<string> = new Set([
  "webhooks",
  "mcp.servers",
  "llm.providers",
]);

/*
 * The fields of the `llm` blocks. A field missing here would look like a
 * key from a newer build and come back after a caller removed it (the
 * pins `scrubRunModeProviderPins` clears), so each list is a `Record` over
 * its config type: a field added to the type and not here does not compile.
 */
const LLM_KEYS: Record<keyof UserLlmFileConfig, true> = {
  activeTextProvider: true,
  activeEmbeddingProvider: true,
  toolTransport: true,
  providers: true,
  fallback: true,
  runMode: true,
  openrouter: true,
  costTracking: true,
};
const LLM_FALLBACK_KEYS: Record<keyof UserLlmFallbackConfig, true> = {
  chain: true,
  appendLocal: true,
  failureThreshold: true,
  cooldownMs: true,
  probeThrottleMs: true,
  failureWindowMs: true,
};
const LLM_RUN_MODE_KEYS: Record<keyof UserLlmRunModeConfig, true> = {
  mode: true,
  fusion: true,
};
const LLM_FUSION_KEYS: Record<keyof UserLlmFusionConfig, true> = {
  orchestratorProvider: true,
  orchestratorModel: true,
  workerProvider: true,
  workerModel: true,
  workers: true,
  cloudWorkers: true,
  workerReasoning: true,
  workerMaxOutputTokens: true,
  workerMaxSteps: true,
  workerTimeoutMs: true,
  reviewStallSteps: true,
  turnBudgetUsd: true,
  turnTimeBudgetMs: true,
  maxRoundsPerTurn: true,
  maxTasksPerTurn: true,
  escalation: true,
  escalationReplace: true,
  escalationProvider: true,
  escalationMaxUsd: true,
  judge: true,
  judgeProvider: true,
  autoReplan: true,
  roles: true,
  mixLocalModels: true,
  isolation: true,
  taskTree: true,
};

/**
 * Keys this build knows in a fixed block although they are not in
 * `USER_CONFIG_DEFAULTS`: emitted only when set (`llm` and its blocks), or retired
 * aliases the parse still reads but never writes back (`telemetry`,
 * `agent.approvalRequired`, `discord.ownerUserId`). Without this list
 * they would look like keys from a newer build and be carried forward
 * for ever, or brought back after a caller removed them.
 */
const KNOWN_KEYS_OUTSIDE_DEFAULTS: Readonly<Record<string, readonly string[]>> = {
  "": ["llm", "telemetry"],
  agent: ["approvalRequired"],
  discord: ["ownerUserId"],
  llm: Object.keys(LLM_KEYS),
  "llm.fallback": Object.keys(LLM_FALLBACK_KEYS),
  "llm.runMode": Object.keys(LLM_RUN_MODE_KEYS),
  "llm.runMode.fusion": Object.keys(LLM_FUSION_KEYS),
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function buildChildIndex(): Map<string, Set<string>> {
  const children = new Map<string, Set<string>>();
  const walk = (node: Record<string, unknown>, path: string): void => {
    const names = new Set(Object.keys(node));
    children.set(path, names);
    for (const [name, value] of Object.entries(node)) {
      // `null` and arrays are values, not branches (see config-paths.ts).
      if (isPlainObject(value)) {
        walk(value, path === "" ? name : `${path}.${name}`);
      }
    }
  };
  walk(USER_CONFIG_DEFAULTS as unknown as Record<string, unknown>, "");
  return children;
}

const CHILDREN = buildChildIndex();

/** Every object node of `USER_CONFIG_DEFAULTS` except the root, in order. */
export function listDefaultConfigBranches(): readonly string[] {
  return [...CHILDREN.keys()].filter((path) => path !== "");
}

/**
 * The kind of the object node at `path` (`""` is the root), or
 * `undefined` for anything this build does not classify: a leaf, an
 * unknown block, or a node inside a dictionary. Callers treat
 * `undefined` like a dictionary, as one whole value.
 */
export function configBranchKind(path: string): ConfigBranchKind | undefined {
  if (FIXED_CONFIG_BRANCHES.has(path)) return "fixed";
  if (DICTIONARY_CONFIG_BRANCHES.has(path)) return "dictionary";
  return undefined;
}

/** Key names this build knows directly under the fixed block at `path`. */
export function knownConfigKeys(path: string): ReadonlySet<string> {
  return new Set([
    ...(CHILDREN.get(path) ?? []),
    ...(KNOWN_KEYS_OUTSIDE_DEFAULTS[path] ?? []),
  ]);
}
