import { isDeepStrictEqual } from "node:util";

import { BACKEND_VARIANT_PREFERENCES } from "../local-llm/backend/windows-backend-variant.js";
import { TOOL_SEARCH_MODES } from "./agent/agent-parser.js";
import { COMPACTION_MODES } from "./agent/compaction-config.js";
import { parseUserConfigFile, type UserConfigFile } from "./config-schema.js";
import { LLM_TOOL_TRANSPORTS } from "./llm-config.js";
import {
  FUSION_ESCALATION_MODES,
  FUSION_ISOLATION_MODES,
  FUSION_JUDGE_MODES,
  FUSION_ROLES,
  FUSION_WORKER_REASONING_LEVELS,
  RUN_MODE_NAMES,
} from "./llm-run-mode-config.js";
import { keepSetAsideLocalModelValues } from "./local-models/keep-set-aside-values.js";
import { WHILE_BUSY_SUBMIT_MODES } from "./tui-config.js";

type Tree = Record<string, unknown>;

/** The managed local engines this build runs. */
const MANAGED_ENGINES: readonly string[] = ["llama-server", "atomic-core"];

/**
 * Enum-like settings a newer build may hold a value for that this build
 * reads as the default or unset, with one notice (ATO-1241; the managed
 * engine and backend variant of ATO-1239 joined this rule in ATO-1265, so
 * an engine picked here is no longer overwritten by the newer one; the
 * managed model id is kept by `keepSetAsideLocalModelValues`).
 */
export const SET_ASIDE_ENUM_KEYS: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  ["llm.toolTransport", LLM_TOOL_TRANSPORTS],
  ["llm.runMode.mode", RUN_MODE_NAMES],
  ["llm.runMode.fusion.workerReasoning", FUSION_WORKER_REASONING_LEVELS],
  ["llm.runMode.fusion.escalation", FUSION_ESCALATION_MODES],
  ["llm.runMode.fusion.judge", FUSION_JUDGE_MODES],
  ["llm.runMode.fusion.isolation", FUSION_ISOLATION_MODES],
  ["agent.tools.search", TOOL_SEARCH_MODES],
  ["agent.compaction.mode", COMPACTION_MODES],
  ["tui.whileBusySubmit", WHILE_BUSY_SUBMIT_MODES],
  ["localModels.managed.engine", MANAGED_ENGINES],
  ["localModels.managed.backendVariant", BACKEND_VARIANT_PREFERENCES],
]);

/**
 * Keys `config set` refuses a typed value for when it does not read back
 * as itself: read from the file it is a newer build's choice, typed it is
 * a typo.
 */
export function isSetAsideOnReadKey(key: string): boolean {
  return key.startsWith(`${FUSION_ROLES_KEY}.`) || SET_ASIDE_ENUM_KEYS.has(key);
}

/** References to a provider (and the leg's model label), set aside with it when its kind is unknown here. */
const PROVIDER_REF_KEYS: ReadonlyArray<readonly [string, string?]> = [
  ["llm.activeTextProvider"],
  ["llm.activeEmbeddingProvider"],
  ["llm.fallback.chain"],
  ["llm.runMode.fusion.orchestratorProvider", "llm.runMode.fusion.orchestratorModel"],
  ["llm.runMode.fusion.workerProvider", "llm.runMode.fusion.workerModel"],
  ["llm.runMode.fusion.escalationProvider"],
  ["llm.runMode.fusion.judgeProvider"],
];

const FUSION_ROLES_KEY = "llm.runMode.fusion.roles";

/**
 * The write half of reading a newer build's values leniently. A
 * whole-file write of a parsed config would put the stand-in (default,
 * unset, or a provider left out) over what the newer build wrote, so a
 * value on disk this build set aside is kept wherever `data` still holds
 * exactly what this build read from that disk value. A choice made here
 * differs from what was read and replaces it, as before.
 *
 * "What this build read" is the disk tree parsed again; when that fails
 * the file is broken in some other way and `data` is written as is.
 */
export function keepSetAsideConfigValues(data: UserConfigFile, disk: Tree): UserConfigFile {
  const withLocalModels = keepSetAsideLocalModelValues(data, disk);
  let read: UserConfigFile;
  try {
    read = parseUserConfigFile(disk);
  } catch {
    return withLocalModels;
  }
  let out = withLocalModels as unknown as Tree;
  for (const [key, known] of SET_ASIDE_ENUM_KEYS) {
    const d = getPath(disk, key);
    if (typeof d === "string" && d.length > 0 && !known.includes(d)) out = keepAt(out, disk, read, key);
  }
  out = keepSetAsideProviders(out, disk, read);
  out = keepUnknownRolePins(out, disk, read);
  return out === (withLocalModels as unknown) ? withLocalModels : (out as unknown as UserConfigFile);
}

function keepSetAsideProviders(out: Tree, disk: Tree, read: UserConfigFile): Tree {
  const diskProviders = getPath(disk, "llm.providers");
  const outProviders = getPath(out, "llm.providers");
  if (!Array.isArray(diskProviders) || !Array.isArray(outProviders)) return out;
  const readIds = new Set((read.llm?.providers ?? []).map((p) => p.id));
  const setAside = new Set<string>();
  let providers = outProviders.map((p) => keepModelModes(p as Tree, diskProviders, read));
  diskProviders.forEach((entry, i) => {
    const id = isPlain(entry) ? entry.id : undefined;
    if (typeof id !== "string" || readIds.has(id)) return;
    setAside.add(id);
    if (providers.some((p) => (p as Tree).id === id)) return; // a provider added here under that id wins
    providers = [...providers.slice(0, i), entry, ...providers.slice(i)];
  });
  const changed = providers.length !== outProviders.length || providers.some((p, i) => p !== outProviders[i]);
  let next = changed ? setPath(out, "llm.providers", providers) : out;
  if (setAside.size === 0) return next;
  const refers = (v: unknown): boolean =>
    (typeof v === "string" && setAside.has(v)) || (Array.isArray(v) && v.some((id) => typeof id === "string" && setAside.has(id)));
  for (const [ref, label] of PROVIDER_REF_KEYS) {
    if (!refers(getPath(disk, ref))) continue;
    next = keepAt(next, disk, read, ref);
    if (label) next = keepAt(next, disk, read, label);
  }
  const roles = getPath(disk, FUSION_ROLES_KEY);
  if (isPlain(roles)) {
    for (const [role, id] of Object.entries(roles)) {
      if (refers(id)) next = keepAt(next, disk, read, `${FUSION_ROLES_KEY}.${role}`);
    }
  }
  return next;
}

/**
 * Pins of roles a newer build added (skipped on read). A pin to a provider
 * that is gone stays gone: `scrubRunModeProviderPins` cannot see these
 * roles, so putting it back would leave the newer build a dangling id.
 */
function keepUnknownRolePins(out: Tree, disk: Tree, read: UserConfigFile): Tree {
  const roles = getPath(disk, FUSION_ROLES_KEY);
  const providers = getPath(out, "llm.providers");
  if (!isPlain(roles) || !Array.isArray(providers)) return out;
  const ids = new Set(providers.map((p) => (isPlain(p) ? p.id : undefined)));
  let next = out;
  for (const [role, id] of Object.entries(roles)) {
    if ((FUSION_ROLES as readonly string[]).includes(role) || !ids.has(id)) continue;
    next = keepAt(next, disk, read, `${FUSION_ROLES_KEY}.${role}`);
  }
  return next;
}

/** A per-provider `modelMode` / `modelModes` value a newer build added (read as unset here). */
function keepModelModes(provider: Tree, diskProviders: unknown[], read: UserConfigFile): Tree {
  const onDisk = diskProviders.find((p) => isPlain(p) && p.id === provider.id) as Tree | undefined;
  const wasRead = read.llm?.providers.find((p) => p.id === provider.id) as unknown as Tree | undefined;
  if (!onDisk || !wasRead) return provider;
  const unknownMode = (v: unknown): boolean => typeof v === "string" && v.length > 0 && v !== "local" && v !== "cloud";
  let next = provider;
  if (unknownMode(onDisk.modelMode)) next = keepAt(next, onDisk, wasRead, "modelMode");
  const modes = onDisk.modelModes;
  if (isPlain(modes)) {
    for (const [model, mode] of Object.entries(modes)) {
      if (!unknownMode(mode)) continue;
      const current = isPlain(next.modelModes) ? next.modelModes : undefined;
      const readModes = isPlain(wasRead.modelModes) ? wasRead.modelModes : undefined;
      if (current?.[model] !== undefined || readModes?.[model] !== undefined) continue;
      next = { ...next, modelModes: { ...current, [model]: mode } };
    }
  }
  return next;
}

/** Put the disk value at `key` back when it differs from what was read and `out` still holds what was read. */
function keepAt(out: Tree, disk: unknown, read: unknown, key: string): Tree {
  const d = getPath(disk, key);
  const r = getPath(read, key);
  if (d === undefined || isDeepStrictEqual(d, r) || !isDeepStrictEqual(getPath(out, key), r)) return out;
  return setPath(out, key, d);
}

function isPlain(v: unknown): v is Tree {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function getPath(tree: unknown, key: string): unknown {
  let node = tree;
  for (const part of key.split(".")) {
    if (!isPlain(node) || !Object.hasOwn(node, part)) return undefined;
    node = node[part];
  }
  return node;
}

function setPath(tree: Tree, key: string, value: unknown): Tree {
  const [head, ...rest] = key.split(".") as [string, ...string[]];
  const child = tree[head];
  return { ...tree, [head]: rest.length === 0 ? value : setPath(isPlain(child) ? child : {}, rest.join("."), value) };
}
