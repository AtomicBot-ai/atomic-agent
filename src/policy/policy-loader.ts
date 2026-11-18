import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, posix, win32 } from "node:path";
import type {
  EffectivePolicy,
  PolicySourceKind,
  PolicySourceStatus,
  SourcedPolicyRule,
} from "./policy-evaluator.js";
import { parsePolicyFile, parsePolicyText, type PolicyFile } from "./policy-schema.js";

/** Env var naming a policy to fetch at start (like Goose's `GOOSE_ALLOWLIST`). */
export const POLICY_URL_ENV = "ATOMIC_POLICY_URL";
export const USER_POLICY_FILE = "policy.json";
export const POLICY_CACHE_FILE = "policy-cache.json";
const DEFAULT_FETCH_TIMEOUT_MS = 3_000;

export interface PolicyLoaderDeps {
  stateDir: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** File contents, or null when the file does not exist. Other errors throw. */
  readText?: (path: string) => string | null;
  writeText?: (path: string, text: string) => void;
  fetchText?: (url: string, timeoutMs: number) => Promise<string>;
  now?: () => Date;
  timeoutMs?: number;
}

/** The machine-wide file an administrator (MDM, Ansible, GPO) puts in place. */
export function systemPolicyPath(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === "darwin") return "/Library/Application Support/AtomicAgent/policy.json";
  if (platform === "win32") return win32.join(env.ProgramData ?? "C:\\ProgramData", "AtomicAgent", "policy.json");
  return posix.join("/etc", "atomic-agent", "policy.json");
}

export function userPolicyPath(stateDir: string): string {
  return join(stateDir, USER_POLICY_FILE);
}

/** A URL without its query and fragment, which may carry a token. */
export function redactPolicyUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}${u.search ? "?…" : ""}`;
  } catch {
    return "(invalid URL)";
  }
}

function defaultReadText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function defaultWriteText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

async function defaultFetchText(url: string, timeoutMs: number): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export interface LoadedPolicySource {
  status: PolicySourceStatus;
  file?: PolicyFile;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readFileSource(kind: PolicySourceKind, path: string, readText: (p: string) => string | null): LoadedPolicySource {
  try {
    const text = readText(path);
    if (text === null) return { status: { kind, location: path, state: "missing" } };
    return { status: { kind, location: path, state: "loaded" }, file: parsePolicyText(text) };
  } catch (err) {
    return { status: { kind, location: path, state: "invalid", error: errorText(err) } };
  }
}

interface CacheEntry {
  url: string;
  fetchedAt: string;
  policy: unknown;
}

function readCache(deps: Required<Pick<PolicyLoaderDeps, "readText">> & PolicyLoaderDeps, url: string): { file: PolicyFile; fetchedAt: string } | null {
  try {
    const text = deps.readText(join(deps.stateDir, POLICY_CACHE_FILE));
    if (text === null) return null;
    const entry = JSON.parse(text) as Partial<CacheEntry>;
    // A copy cached for another URL is not this organisation's policy.
    if (entry.url !== url || typeof entry.fetchedAt !== "string") return null;
    return { file: parsePolicyFile(entry.policy), fetchedAt: entry.fetchedAt };
  } catch {
    return null;
  }
}

function fromCache(deps: Required<Pick<PolicyLoaderDeps, "readText">> & PolicyLoaderDeps, url: string, error?: string): LoadedPolicySource {
  const location = redactPolicyUrl(url);
  const cached = readCache(deps, url);
  if (cached === null) {
    return { status: { kind: "url", location, state: "unreachable", ...(error ? { error } : {}) } };
  }
  return {
    status: { kind: "url", location, state: "cached", fetchedAt: cached.fetchedAt, ...(error ? { error } : {}) },
    file: cached.file,
  };
}

/** Combine sources, weakest first: later rules come later in evaluation order. */
export function mergePolicySources(loaded: readonly LoadedPolicySource[]): EffectivePolicy {
  const rules: SourcedPolicyRule[] = [];
  let mcpAllowlist: EffectivePolicy["mcpAllowlist"];
  for (const { status, file } of loaded) {
    if (file === undefined) continue;
    file.rules.forEach((rule, index) => rules.push({ ...rule, source: status.kind, index }));
    if (file.mcpAllowlist !== undefined) mcpAllowlist = { ...file.mcpAllowlist, source: status.kind };
  }
  return {
    rules,
    ...(mcpAllowlist !== undefined ? { mcpAllowlist } : {}),
    sources: loaded.map((l) => l.status),
  };
}

function withDefaults(deps: PolicyLoaderDeps) {
  return {
    ...deps,
    platform: deps.platform ?? process.platform,
    env: deps.env ?? process.env,
    readText: deps.readText ?? defaultReadText,
  };
}

function localSources(d: ReturnType<typeof withDefaults>): LoadedPolicySource[] {
  return [
    readFileSource("user", userPolicyPath(d.stateDir), d.readText),
    readFileSource("system", systemPolicyPath(d.platform, d.env), d.readText),
  ];
}

function policyUrl(env: NodeJS.ProcessEnv): string | undefined {
  const url = env[POLICY_URL_ENV]?.trim();
  return url ? url : undefined;
}

/**
 * The policy without network: both files plus the last fetched copy of
 * `ATOMIC_POLICY_URL`. For short-lived commands (`skill install`, `policy
 * show`) and as the fallback before the runtime has fetched.
 */
export function loadLocalPolicy(deps: PolicyLoaderDeps): EffectivePolicy {
  const d = withDefaults(deps);
  const url = policyUrl(d.env);
  const loaded = localSources(d);
  if (url !== undefined) loaded.push(fromCache(d, url));
  return mergePolicySources(loaded);
}

/**
 * The policy at start: both files, then `ATOMIC_POLICY_URL` fetched with a
 * short timeout. A good copy is cached; when the fetch fails (offline, a
 * 500, bad JSON) the cached copy is used. Never throws, never waits longer
 * than the timeout: a policy server that is down must not stop the agent.
 */
export async function loadPolicy(deps: PolicyLoaderDeps): Promise<EffectivePolicy> {
  const d = withDefaults(deps);
  const url = policyUrl(d.env);
  const loaded = localSources(d);
  if (url !== undefined) loaded.push(await fetchSource(d, url));
  return mergePolicySources(loaded);
}

async function fetchSource(d: ReturnType<typeof withDefaults>, url: string): Promise<LoadedPolicySource> {
  const fetchText = d.fetchText ?? defaultFetchText;
  let fetched: { raw: unknown; file: PolicyFile };
  try {
    const raw: unknown = JSON.parse(await fetchText(url, d.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS));
    fetched = { raw, file: parsePolicyFile(raw) };
  } catch (err) {
    return fromCache(d, url, errorText(err));
  }
  const { raw, file } = fetched;
  const fetchedAt = (d.now?.() ?? new Date()).toISOString();
  try {
    const entry: CacheEntry = { url, fetchedAt, policy: raw };
    (d.writeText ?? defaultWriteText)(join(d.stateDir, POLICY_CACHE_FILE), `${JSON.stringify(entry, null, 2)}\n`);
  } catch {
    // An unwritable cache only costs the offline fallback next time.
  }
  return { status: { kind: "url", location: redactPolicyUrl(url), state: "loaded", fetchedAt }, file };
}
