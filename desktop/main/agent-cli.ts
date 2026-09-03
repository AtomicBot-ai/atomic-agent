import { execFile, spawn } from "node:child_process";
import { homedir, totalmem } from "node:os";
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { resolveBinary } from "./agent-client.js";

const run = promisify(execFile);

/**
 * The agent's own CLI, used for the things the HTTP API deliberately
 * cannot do.
 *
 * Config writes in particular: `PATCH /api/config` merges only four
 * blocks and re-defaults everything else, so a single call through it
 * would silently reset `llm.providers`, `mcp.servers` and `memory.*`.
 * `atag config set <dotted.key> <value>` is a sparse point edit that
 * leaves the rest of the file alone, which is what the setup wizard
 * needs.
 *
 * Arguments are always passed as an array — never a shell string.
 */

export interface CliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

async function cli(args: string[], timeout = 30_000): Promise<CliResult> {
  const binary = resolveBinary();
  if (!binary) return { ok: false, stdout: "", stderr: "", error: "no atomic-agent binary found" };
  try {
    const { stdout, stderr } = await run(binary, args, { timeout, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, stdout, stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      error: e.stderr?.trim() || e.message || "command failed",
    };
  }
}

export async function configGet(): Promise<{ ok: boolean; config?: unknown; error?: string }> {
  const res = await cli(["config", "get"]);
  if (!res.ok) return { ok: false, error: res.error };
  try {
    return { ok: true, config: JSON.parse(res.stdout) };
  } catch {
    return { ok: false, error: "config get did not return JSON" };
  }
}

/** One dotted key at a time, exactly as the CLI documents it. */
export async function configSet(key: string, value: string): Promise<CliResult> {
  if (!/^[a-zA-Z][\w.]{0,80}$/.test(key)) {
    return { ok: false, stdout: "", stderr: "", error: `refusing to write a suspicious key: ${key}` };
  }
  // Lane B — backend switch. The CLI's dotted-key table is derived from
  // USER_CONFIG_DEFAULTS, which has no `llm` block, so every `llm.*` key
  // is "unknown key" on 0.5.4. Refuse here with a pointer at the
  // whole-file helpers below rather than letting the dead path back in.
  if (key === "llm" || key.startsWith("llm.")) {
    return {
      ok: false, stdout: "", stderr: "",
      error: `${key} has no dotted spelling in this agent — use setActiveTextProvider / selectCloudModel`,
    };
  }
  return cli(["config", "set", key, value]);
}

export interface CatalogModel {
  id: string;
  family: string;
  size: string;
  context: string;
  downloaded: boolean;
  active: boolean;
}

/**
 * `models list` prints a table, not JSON. Parsing it is the price of
 * showing the operator the real catalog with real disk state rather
 * than a list this app invented.
 */
export async function modelsList(): Promise<{ ok: boolean; models?: CatalogModel[]; error?: string }> {
  const res = await cli(["models", "list"], 45_000);
  if (!res.ok) return { ok: false, error: res.error };
  const models: CatalogModel[] = [];
  for (const line of res.stdout.split("\n")) {
    if (!line.includes("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 5 || cells[0] === "ID" || !cells[0]) continue;
    models.push({
      id: cells[0]!,
      family: cells[1] ?? "",
      size: cells[2] ?? "",
      context: cells[3] ?? "",
      downloaded: (cells[4] ?? "").toLowerCase() === "yes",
      active: (cells[5] ?? "").includes("*"),
    });
  }
  return models.length ? { ok: true, models } : { ok: false, error: "could not parse the model catalog" };
}

export async function modelsUse(id: string): Promise<CliResult> {
  if (!/^[\w.-]{1,64}$/.test(id)) {
    return { ok: false, stdout: "", stderr: "", error: `not a model id: ${id}` };
  }
  const res = await cli(["models", "use", id], 60_000);
  if (!res.ok) return res;
  // Lane B — backend switch. `models use` writes localModels.mode +
  // managed.modelId but does not re-sync llm.providers[local-llama].url
  // (src/cli/models-handlers.ts runLocalModelsUse), while the runtime
  // takes the file's url verbatim. The TUI's setActive goes through
  // persistUserLocalModelsConfig, which syncs; do the same here.
  const synced = await syncLocalLlamaProviderUrlInFile();
  if (!synced.ok) return { ...res, ok: false, error: synced.error };
  return res;
}

/**
 * A download is minutes long, so it streams progress instead of
 * resolving at the end.
 */
export function modelsPull(
  id: string,
  onLine: (line: string) => void,
): { done: Promise<CliResult>; cancel: () => void } {
  const binary = resolveBinary();
  if (!binary || !/^[\w.-]{1,64}$/.test(id)) {
    return {
      done: Promise.resolve({ ok: false, stdout: "", stderr: "", error: "cannot start the download" }),
      cancel: () => {},
    };
  }
  const child = spawn(binary, ["models", "pull", id], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  const relay = (chunk: Buffer, sink: "out" | "err") => {
    const text = chunk.toString("utf8");
    if (sink === "out") stdout += text;
    else stderr += text;
    for (const line of text.split(/[\r\n]/)) if (line.trim()) onLine(line.trim());
  };
  child.stdout.on("data", (c: Buffer) => relay(c, "out"));
  child.stderr.on("data", (c: Buffer) => relay(c, "err"));
  const done = new Promise<CliResult>((resolve) => {
    child.on("exit", (code) =>
      resolve(
        code === 0
          ? { ok: true, stdout, stderr }
          : { ok: false, stdout, stderr, error: `download exited with code ${code ?? "null"}` },
      ),
    );
    child.on("error", (err) => resolve({ ok: false, stdout, stderr, error: err.message }));
  });
  return { done, cancel: () => child.kill("SIGTERM") };
}

/** Whole gigabytes, the unit the catalog's RAM advice is written in. */
export function hostRamGb(): number {
  return Math.max(1, Math.floor(totalmem() / 1_000_000_000));
}

/**
 * The env var each cloud provider reads its key from. The wizard shows
 * this rather than pretending it can store a key: keys live in the
 * environment (or the state dir's .env), not in config.json.
 */
export const PROVIDER_KEY_ENV: Record<string, string> = {
  openrouter: "OPENROUTER_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
  aimlapi: "AIMLAPI_API_KEY",
  openai: "OPENAI_API_KEY",
};

/* ---------------------------------------------------------------
   Cloud providers.

   `llm.providers` is a list-valued key, and the CLI is explicit that
   those "have no single-value spelling — set those with the whole-file
   JSON form". So a provider edit reads the whole config, changes one
   entry, and writes the whole file back. That is not the same hazard as
   PATCH /api/config: this payload is the file we just read, so nothing
   is dropped.

   Every preset resolves to the existing `openai-compatible` kind with
   `baseUrl` filled in — see src/tui/providers/provider-presets.ts.
   --------------------------------------------------------------- */

export interface ProviderEntry {
  id: string;
  kind: string;
  baseUrl?: string;
  /** llama-server entries: the chat daemon's URL. */
  url?: string;
  apiKey?: string;
  apiKeyEnvVar?: string;
  apiKeyHeader?: string;
  headers?: Record<string, string>;
  defaultChatModel?: string;
  model?: string;
  subscriptionCli?: { cli?: string };
}

export async function configSetWhole(config: unknown): Promise<CliResult> {
  return cli(["config", "set", JSON.stringify(config)], 30_000);
}

/** Add a provider, or replace the entry that already carries its id. */
export async function upsertProvider(entry: ProviderEntry): Promise<CliResult> {
  if (!/^[\w.-]{1,48}$/.test(entry.id)) {
    return { ok: false, stdout: "", stderr: "", error: `not a provider id: ${entry.id}` };
  }
  const current = await configGet();
  if (!current.ok || !current.config) {
    return { ok: false, stdout: "", stderr: "", error: current.error ?? "could not read the config" };
  }
  const config = current.config as { llm?: { providers?: ProviderEntry[] } };
  const llm = (config.llm ??= {});
  const providers = (llm.providers ??= []);
  const at = providers.findIndex((p) => p.id === entry.id);
  const clean = Object.fromEntries(
    Object.entries(entry).filter(([, v]) => v !== undefined && v !== ""),
  ) as ProviderEntry;
  if (at >= 0) providers[at] = { ...providers[at], ...clean };
  else providers.push(clean);
  return configSetWhole(config);
}

/** Point a configured provider at one of its models. */
export async function setProviderModel(id: string, model: string): Promise<CliResult> {
  if (!model.trim()) return { ok: false, stdout: "", stderr: "", error: "model required" };
  return upsertProvider({ id, kind: "", defaultChatModel: model } as ProviderEntry);
}

export interface SearchedModel {
  provider: string;
  id: string;
  kind?: string;
  contextWindow?: number;
  supportsVision?: boolean;
  supportsTools?: string | boolean;
}

/** The provider's live model list, as `atag models search --json` reports it. */
export async function modelsSearch(
  query: string,
  provider?: string,
  limit = 40,
): Promise<{ ok: boolean; models?: SearchedModel[]; error?: string }> {
  const args = ["models", "search", query || "", "--limit", String(Math.min(200, Math.max(1, limit))), "--json"];
  if (provider) {
    if (!/^[\w.-]{1,48}$/.test(provider)) return { ok: false, error: "bad provider id" };
    args.push("--provider", provider);
  }
  const res = await cli(args, 60_000);
  if (!res.ok) return { ok: false, error: res.error };
  try {
    const parsed = JSON.parse(res.stdout) as SearchedModel[];
    return { ok: true, models: Array.isArray(parsed) ? parsed : [] };
  } catch {
    return { ok: false, error: "models search did not return JSON" };
  }
}

/** Start the managed llama daemon after switching to a local model. */
export async function modelsStart(): Promise<CliResult> {
  return cli(["models", "start"], 90_000);
}

/**
 * A provider's model list.
 *
 * Two quirks of `models search`, both load-bearing:
 *  - it refuses an empty query, but a single space parses to zero terms
 *    and returns the whole catalogue, which is how a picker shows rows
 *    before the user types;
 *  - only `openrouter` and `aimlapi` ship bundled catalogues, so every
 *    other kind needs `--refresh` to fetch a live list.
 */
export async function providerModels(
  providerId: string,
  kind: string,
): Promise<{ ok: boolean; models?: SearchedModel[]; error?: string }> {
  if (!/^[\w.-]{1,48}$/.test(providerId)) return { ok: false, error: "bad provider id" };
  const bundled = kind === "openrouter" || kind === "aimlapi";
  const args = ["models", "search", " ", "--provider", providerId, "--limit", "200", "--json"];
  if (!bundled) args.push("--refresh");
  const res = await cli(args, 90_000);
  if (!res.ok) return { ok: false, error: res.error };
  try {
    const parsed = JSON.parse(res.stdout) as SearchedModel[];
    return { ok: true, models: Array.isArray(parsed) ? parsed : [] };
  } catch {
    return { ok: false, error: "models search did not return JSON" };
  }
}

/* ---------------------------------------------------------------
   Context usage.

   The SSE `usage` frame is hardcoded zeros — `buildUsagePayload` in
   src/http/openai-chunks.ts says so in its own comment. The honest
   source is the append-only trace `serve` writes at
   <stateDir>/traces/<sessionId>.ndjson, where `llm_completion` carries
   the provider's real prompt count and `prompt_captured` carries the
   scaffold/tail split. This is the same number the TUI's chip shows.
   --------------------------------------------------------------- */

export interface TraceUsage {
  tokens: number;
  source: "provider" | "estimate";
  stablePrefix: number;
  tail: number;
  cacheHitTokens: number | null;
  modelId: string | null;
  turnIndex: number;
}

export async function traceUsage(
  stateDir: string,
  sessionId: string,
): Promise<{ ok: boolean; usage?: TraceUsage; error?: string }> {
  if (!/^[\w.-]{1,80}$/.test(sessionId)) return { ok: false, error: "bad session id" };
  if (!stateDir) return { ok: false, error: "no state dir" };
  const file = join(stateDir, "traces", `${sessionId}.ndjson`);
  let text: string;
  try {
    const size = statSync(file).size;
    const from = Math.max(0, size - 256 * 1024);
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(size - from);
      readSync(fd, buf, 0, buf.length, from);
      text = buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "no trace yet" };
  }

  const lines = text.split("\n");
  let captured: { total?: number; stablePrefix?: number; tail?: number; turnIndex?: number } | null = null;
  let completion: { promptTokens?: number; cacheHitTokens?: number; modelId?: string } | null = null;
  for (let i = lines.length - 1; i >= 0 && (!captured || !completion); i--) {
    const line = lines[i]?.trim();
    if (!line || line[0] !== "{") continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const kind = row["event"] ?? row["type"] ?? row["kind"];
    if (!completion && kind === "llm_completion") {
      const timing = (row["timing"] ?? {}) as Record<string, number>;
      completion = {
        promptTokens: timing["promptTokens"],
        cacheHitTokens: row["cacheHitTokens"] as number | undefined,
        modelId: row["modelId"] as string | undefined,
      };
    }
    if (!captured && kind === "prompt_captured") {
      const tokens = (row["tokens"] ?? {}) as Record<string, number>;
      captured = {
        total: tokens["total"],
        stablePrefix: tokens["stablePrefix"],
        tail: tokens["tail"],
        turnIndex: row["turnIndex"] as number | undefined,
      };
    }
  }
  if (!captured && !completion) return { ok: false, error: "no measurement in the trace yet" };
  const provider = completion?.promptTokens && completion.promptTokens > 0 ? completion.promptTokens : 0;
  return {
    ok: true,
    usage: {
      tokens: provider || captured?.total || 0,
      source: provider ? "provider" : "estimate",
      stablePrefix: captured?.stablePrefix ?? 0,
      tail: captured?.tail ?? 0,
      cacheHitTokens: completion?.cacheHitTokens ?? null,
      modelId: completion?.modelId ?? null,
      turnIndex: captured?.turnIndex ?? 0,
    },
  };
}

/* ---------------------------------------------------------------
   Lane B — context before the first message (item 3).

   Before the first turn nothing has been measured, and the TUI shows
   nothing (selectContextUsage returns null while tokens === null). The
   desktop instead PROJECTS from the one thing the installed agent
   already produces: the turn-0 `prompt_captured.tokens.stablePrefix`
   of the newest trace built in the same workspace. The scaffold is
   tools + capabilities + skills + persona — its hash tracks the
   workspace (CapabilitiesSummary.workingDir is part of it), not the
   model — so the ranking is workspace match first, then newest. The
   model is carried only as information for the panel's basis line.
   --------------------------------------------------------------- */

export interface TraceBaseline {
  sessionId: string;
  /** `prompt_captured.ts` of the turn-0 prompt. */
  at: number;
  workingDir: string | null;
  /** The provider's echoed model id from the completion that followed. */
  modelId: string | null;
  stablePrefix: number;
  tail: number;
  total: number;
  stablePrefixHash: string;
  workspaceMatch: boolean;
  modelMatch: boolean;
}

type BaselineCandidate = Omit<TraceBaseline, "workspaceMatch" | "modelMatch">;

/** Parsed trace heads, keyed by `<file>:<mtimeMs>`; a file that changed is read again. */
const BASELINE_CACHE = new Map<string, BaselineCandidate | null>();
const BASELINE_HEAD_BYTES = 96 * 1024;
const BASELINE_MAX_FILES = 60;

/**
 * `llm_completion.modelId` is the provider's echoed `model` field, which
 * for aimlapi/openrouter drops the vendor prefix (`glm-5.2` for
 * `zhipu/glm-5.2`), so ids match when either the whole id or the
 * basename matches, case-insensitively.
 */
export function sameModel(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la === lb) return true;
  const base = (s: string) => s.split("/").pop() ?? s;
  return base(la) === base(lb);
}

function readTraceHead(file: string, sessionId: string, mtimeMs: number): BaselineCandidate | null {
  const key = `${file}:${mtimeMs}`;
  const cached = BASELINE_CACHE.get(key);
  if (cached !== undefined) return cached;
  if (BASELINE_CACHE.size > 512) BASELINE_CACHE.clear();
  let text: string;
  try {
    const size = statSync(file).size;
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(Math.min(size, BASELINE_HEAD_BYTES));
      const n = readSync(fd, buf, 0, buf.length, 0);
      text = buf.subarray(0, n).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    BASELINE_CACHE.set(key, null);
    return null;
  }
  let workingDir: string | null = null;
  let candidate: BaselineCandidate | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line[0] !== "{") continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // the clipped last line, or a torn write
    }
    const kind = row["type"] ?? row["event"] ?? row["kind"];
    if (kind === "session_started" && typeof row["workingDir"] === "string") {
      workingDir = row["workingDir"];
      continue;
    }
    if (!candidate && kind === "prompt_captured" && row["turnIndex"] === 0 && row["stepIndex"] === 0) {
      const tokens = (row["tokens"] ?? {}) as Record<string, unknown>;
      const stablePrefix = tokens["stablePrefix"];
      if (typeof stablePrefix !== "number" || stablePrefix <= 0) break;
      candidate = {
        sessionId: typeof row["sessionId"] === "string" ? row["sessionId"] : sessionId,
        at: typeof row["ts"] === "number" ? row["ts"] : mtimeMs,
        workingDir,
        modelId: null,
        stablePrefix,
        tail: typeof tokens["tail"] === "number" ? tokens["tail"] : 0,
        total: typeof tokens["total"] === "number" ? tokens["total"] : stablePrefix,
        stablePrefixHash: typeof row["stablePrefixHash"] === "string" ? row["stablePrefixHash"] : "",
      };
      continue;
    }
    if (candidate && kind === "llm_completion") {
      if (typeof row["modelId"] === "string" && row["modelId"]) candidate.modelId = row["modelId"];
      break; // the first completion after the turn-0 prompt names the model; nothing else is needed
    }
  }
  BASELINE_CACHE.set(key, candidate);
  return candidate;
}

/**
 * The newest turn-0 scaffold this agent built, preferring the same
 * workspace. `want.model` is only compared for the basis line; pass null
 * when no model is chosen.
 */
export async function traceBaseline(
  stateDir: string,
  want: { model: string | null; workingDir: string | null },
): Promise<{ ok: boolean; baseline?: TraceBaseline; error?: string }> {
  if (!stateDir) return { ok: false, error: "no state dir" };
  const dir = join(stateDir, "traces");
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => /^(api|s)-[\w-]+\.ndjson$/.test(f));
  } catch {
    return { ok: false, error: "no trace on this machine yet" };
  }
  const files: Array<{ file: string; sessionId: string; mtimeMs: number }> = [];
  for (const name of names) {
    const file = join(dir, name);
    try {
      files.push({ file, sessionId: name.replace(/\.ndjson$/, ""), mtimeMs: statSync(file).mtimeMs });
    } catch {
      // deleted between readdir and stat
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const candidates: BaselineCandidate[] = [];
  for (const f of files.slice(0, BASELINE_MAX_FILES)) {
    const c = readTraceHead(f.file, f.sessionId, f.mtimeMs);
    if (c) candidates.push(c);
  }
  if (candidates.length === 0) return { ok: false, error: "no trace on this machine yet" };
  const inWorkspace = (c: BaselineCandidate) => !!want.workingDir && c.workingDir === want.workingDir;
  candidates.sort((a, b) => Number(inWorkspace(b)) - Number(inWorkspace(a)) || b.at - a.at);
  const best = candidates[0]!;
  return {
    ok: true,
    baseline: { ...best, workspaceMatch: inWorkspace(best), modelMatch: sameModel(best.modelId, want.model) },
  };
}

/**
 * The catalogue's context window for one model — TUI resolveWindow
 * source 3 (src/tui/select-context-usage.ts), read through
 * `atag models search <id> --provider <id> --json` so the chip knows the
 * window without the model picker ever having been opened. Memoised per
 * (provider, model): the bundled catalogues answer in ~0.3 s, but a
 * `--refresh` for the other kinds is a network round trip. A miss is
 * remembered for five minutes so a model the catalogue does not know
 * is not searched on every repaint. Nothing here ever substitutes a
 * default window: unknown stays null and the panel says "window unknown".
 */
const WINDOW_CACHE = new Map<string, { value: Promise<number | null>; at: number }>();
const WINDOW_MISS_TTL_MS = 5 * 60_000;

export function modelWindow(providerId: string, kind: string, model: string): Promise<number | null> {
  if (!/^[\w.-]{1,48}$/.test(providerId) || !/^[\w.:\/-]{1,120}$/.test(model)) return Promise.resolve(null);
  const key = `${providerId} ${model}`;
  const hit = WINDOW_CACHE.get(key);
  if (hit) return hit.value;
  const bundled = kind === "openrouter" || kind === "aimlapi";
  const args = ["models", "search", model, "--provider", providerId, "--limit", "5", "--json"];
  if (!bundled) args.push("--refresh");
  const value = (async (): Promise<number | null> => {
    const res = await cli(args, 60_000);
    if (!res.ok) return null;
    try {
      const parsed = JSON.parse(res.stdout) as SearchedModel[];
      if (!Array.isArray(parsed)) return null;
      const exact = parsed.find((m) => m.id === model && typeof m.contextWindow === "number" && m.contextWindow > 0);
      return exact ? exact.contextWindow! : null;
    } catch {
      return null;
    }
  })();
  const entry = { value, at: Date.now() };
  WINDOW_CACHE.set(key, entry);
  void value.then((v) => {
    if (v === null) setTimeout(() => { if (WINDOW_CACHE.get(key) === entry) WINDOW_CACHE.delete(key); }, WINDOW_MISS_TTL_MS).unref?.();
  });
  return value;
}

/* ---------------------------------------------------------------
   Lane B — backend switch.

   Ports of the TUI's persist helpers, main-process side:
     setActiveTextProvider     ← src/tui/persist-llm-provider.ts setActiveTextProviderInConfig
     useManagedMode            ← src/tui/persist-user-local-models-config.ts persistUserLocalModelsConfig({mode:"managed"})
     syncLocalLlamaProviderUrl ← same file, syncLocalLlamaProviderUrl
     setMemoryEmbeddingsEnabled← src/tui/persist-embedding-hybrid-recall.ts persistMemoryEmbeddingsEnabled
     providerHasKey            ← src/config/resolve-llm-api-key.ts + provider-auth-mode.ts usesExternalCliAuth
     localDaemonRunning/modelsStop ← `atag models status|stop`

   Every write is the whole-file form (`atag config set '<json>'`) because
   `llm.*` has no dotted spelling on 0.5.4. `atag config get` returns the
   file verbatim — inline apiKey values included — so the object read
   here stays in the main process and is never logged.
   --------------------------------------------------------------- */

export interface UserConfigShape {
  localModels?: {
    url?: string;
    mode?: string;
    managed?: { modelId?: string | null; port?: number };
    embeddings?: { url?: string; enabled?: boolean };
  };
  memory?: { embeddings?: { enabled?: boolean } };
  llm?: {
    activeTextProvider?: string;
    activeEmbeddingProvider?: string;
    toolTransport?: string;
    providers?: ProviderEntry[];
    fallback?: { chain?: string[]; appendLocal?: boolean };
  };
}

export interface WriteResult {
  ok: boolean;
  /** Whether the file content actually changed. */
  changed: boolean;
  error?: string;
}

export async function readWholeConfig(): Promise<{ ok: boolean; config?: UserConfigShape; error?: string }> {
  const current = await configGet();
  if (!current.ok || !current.config || typeof current.config !== "object") {
    return { ok: false, error: current.error ?? "could not read the config" };
  }
  return { ok: true, config: current.config as UserConfigShape };
}

/** persist-llm-provider.ts localLlamaUrlFromFile. */
function localLlamaUrlFromFile(cfg: UserConfigShape): string {
  const lm = cfg.localModels ?? {};
  if (lm.mode === "managed") return `http://127.0.0.1:${lm.managed?.port ?? 19091}`;
  return lm.url ?? "http://127.0.0.1:8080";
}

/**
 * persist-user-local-models-config.ts syncLocalLlamaProviderUrl: the
 * local-llama entry's url follows localModels (managed → the managed
 * port, external → localModels.url) and its baseUrl the embedding url.
 * Mutates `cfg`; returns whether anything changed.
 */
export function syncLocalLlamaProviderUrl(cfg: UserConfigShape): boolean {
  if (!cfg.llm || !Array.isArray(cfg.llm.providers)) return false;
  const url = localLlamaUrlFromFile(cfg);
  const embeddingUrl = cfg.localModels?.embeddings?.url;
  let changed = false;
  cfg.llm.providers = cfg.llm.providers.map((p) => {
    if (p.id !== "local-llama") return p;
    const next: ProviderEntry = { ...p, url };
    if (embeddingUrl !== undefined) next.baseUrl = embeddingUrl;
    if (JSON.stringify(next) !== JSON.stringify(p)) changed = true;
    return next;
  });
  return changed;
}

async function syncLocalLlamaProviderUrlInFile(): Promise<WriteResult> {
  const read = await readWholeConfig();
  if (!read.ok || !read.config) return { ok: false, changed: false, error: read.error };
  if (!syncLocalLlamaProviderUrl(read.config)) return { ok: true, changed: false };
  const w = await configSetWhole(read.config);
  return w.ok ? { ok: true, changed: true } : { ok: false, changed: false, error: w.error };
}

/**
 * setActiveTextProviderInConfig: synthesizes the llm block exactly as
 * the TUI does when it is absent (url only — no baseUrl), refuses an id
 * that names no provider, writes ONLY llm.activeTextProvider.
 */
export async function setActiveTextProvider(id: string): Promise<WriteResult> {
  if (!/^[\w.-]{1,48}$/.test(id)) return { ok: false, changed: false, error: `not a provider id: ${id}` };
  const read = await readWholeConfig();
  if (!read.ok || !read.config) return { ok: false, changed: false, error: read.error };
  const cfg = read.config;
  const llm = (cfg.llm ??= {
    activeTextProvider: "local-llama",
    activeEmbeddingProvider: "local-llama",
    toolTransport: "auto",
    providers: [{ id: "local-llama", kind: "llama-server", url: localLlamaUrlFromFile(cfg) }],
  });
  const providers = (llm.providers ??= []);
  if (!providers.some((p) => p.id === id)) {
    return { ok: false, changed: false, error: `provider "${id}" is not configured` };
  }
  if (llm.activeTextProvider === id) return { ok: true, changed: false };
  llm.activeTextProvider = id;
  const w = await configSetWhole(cfg);
  return w.ok ? { ok: true, changed: true } : { ok: false, changed: false, error: w.error };
}

/** LocalModelsOrchestrator.useManagedMode: persistUserLocalModelsConfig({mode:"managed"}) + url sync. */
export async function useManagedMode(): Promise<WriteResult> {
  const read = await readWholeConfig();
  if (!read.ok || !read.config) return { ok: false, changed: false, error: read.error };
  const cfg = read.config;
  const lm = (cfg.localModels ??= {});
  if (lm.mode === "managed") return { ok: true, changed: false };
  lm.mode = "managed";
  syncLocalLlamaProviderUrl(cfg);
  const w = await configSetWhole(cfg);
  return w.ok ? { ok: true, changed: true } : { ok: false, changed: false, error: w.error };
}

/** persistMemoryEmbeddingsEnabled: a no-op when the flag already matches. */
export async function setMemoryEmbeddingsEnabled(enabled: boolean): Promise<WriteResult> {
  const read = await readWholeConfig();
  if (!read.ok || !read.config) return { ok: false, changed: false, error: read.error };
  const cfg = read.config;
  const mem = (cfg.memory ??= {});
  const emb = (mem.embeddings ??= {});
  if (emb.enabled === enabled) return { ok: true, changed: false };
  emb.enabled = enabled;
  const w = await configSetWhole(cfg);
  return w.ok ? { ok: true, changed: true } : { ok: false, changed: false, error: w.error };
}

/**
 * `atag models status` prints `daemon:         running (pid N)  <url>` or
 * `stopped` in managed mode, and only `mode: external` + `url:` in
 * external mode (src/cli/models-handlers.ts runLocalModelsStatus).
 */
export async function localDaemonRunning(): Promise<boolean> {
  const res = await cli(["models", "status"], 20_000);
  if (!res.ok) return false;
  return /^daemon:\s+running/m.test(res.stdout);
}

/** LocalModelsOrchestrator.stopDaemon's process half: stops chat + embedding daemons. */
export async function modelsStop(): Promise<CliResult> {
  return cli(["models", "stop"], 30_000);
}

/** The agent's own rule for the state dir (src/config/load-config.ts). */
export function stateDirPath(): string {
  return process.env.ATOMIC_AGENT_STATE_DIR ?? join(homedir(), ".atomic-agent");
}

/**
 * The NAMES of the variables the agent will see, and which of them carry
 * a non-empty value: Electron's own environment (it is what `atag serve`
 * and every `atag` subprocess inherit) plus the names declared in
 * <stateDir>/.env, which the CLI's dotenv loader applies only when the
 * process environment does not already set them (load-dotenv.ts
 * `skipped`). Values are never kept, returned or logged.
 */
export interface KeyEnvNames {
  /** Set at all, empty value included — what `??` sees. */
  present: Set<string>;
  /** Set to a non-empty value — what `key.length > 0` sees. */
  nonEmpty: Set<string>;
}

function keyNamesAvailable(): KeyEnvNames {
  const present = new Set<string>();
  const nonEmpty = new Set<string>();
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    present.add(k);
    if (v.length > 0) nonEmpty.add(k);
  }
  try {
    const text = readFileSync(join(stateDirPath(), ".env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
      if (!m) continue;
      const name = m[1]!;
      if (present.has(name)) continue; // the environment wins, as in load-dotenv.ts
      present.add(name);
      if (m[2]!.trim().replace(/^["']|["']$/g, "").length > 0) nonEmpty.add(name);
    }
  } catch {
    // no .env — the environment alone decides
  }
  return { present, nonEmpty };
}

/**
 * resolveLlmProviderApiKey, answered as a boolean; subscription-CLI kinds
 * authenticate elsewhere. The openai-compatible chain is the agent's
 * `A ?? B ?? C` then `length > 0`: the first variable that is SET decides,
 * so `OPENAI_COMPAT_API_KEY=""` next to a real `OPENAI_API_KEY` is "no key"
 * here exactly as it is for the agent.
 */
export function providerHasKey(entry: ProviderEntry, names: KeyEnvNames = keyNamesAvailable()): boolean {
  if (entry.apiKey && entry.apiKey.length > 0) return true;
  if (entry.kind === "subscription-cli" && entry.subscriptionCli?.cli) return true;
  if (entry.apiKeyEnvVar && entry.apiKeyEnvVar.length > 0) return names.nonEmpty.has(entry.apiKeyEnvVar);
  if (entry.kind === "openrouter") return names.nonEmpty.has("OPENROUTER_API_KEY");
  if (entry.kind === "aimlapi") return names.nonEmpty.has("AIMLAPI_API_KEY");
  if (entry.kind === "gemini") return names.nonEmpty.has("GEMINI_API_KEY");
  if (entry.kind === "openai-compatible" || entry.kind === "qwen-openai-compatible") {
    const first = ["OPENAI_COMPAT_API_KEY", "OPENAI_API_KEY", "ATOMIC_AGENT_OPENAI_API_KEY"].find((n) => names.present.has(n));
    return first !== undefined && names.nonEmpty.has(first);
  }
  return false;
}

/** Ids of the configured cloud providers that have a usable key, for the selector's row copy. */
export async function providersReady(): Promise<{ ok: boolean; ids?: string[]; error?: string }> {
  const read = await readWholeConfig();
  if (!read.ok || !read.config) return { ok: false, error: read.error };
  const names = keyNamesAvailable();
  const ids = (read.config.llm?.providers ?? [])
    .filter((p) => p.kind !== "llama-server" && providerHasKey(p, names))
    .map((p) => p.id);
  return { ok: true, ids };
}
