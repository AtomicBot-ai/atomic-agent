import { execFile, spawn } from "node:child_process";
// r5 integration: `homedir` is back for the wizard's import scan only — it
// locates the OTHER agents' state dirs (~/.claude, ~/.codex …), never this
// desktop's own, which is DESKTOP_STATE_DIR (item 9).
import { homedir, totalmem } from "node:os";
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
// Item 7 part C (LLM / Telegram / Import tabs): the .env writer and llama log tail.
import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";

import { resolveBinary } from "./agent-client.js";
// r5 item 9 — every `atag` subprocess runs on the DESKTOP's state directory.
import { agentEnv, DESKTOP_STATE_DIR } from "./state-dir.js";

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

async function cli(args: string[], timeout = 30_000, cwd?: string): Promise<CliResult> {
  const binary = resolveBinary();
  if (!binary) return { ok: false, stdout: "", stderr: "", error: "no atomic-agent binary found" };
  try {
    const { stdout, stderr } = await run(binary, args, {
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      // r5 item 9: named rather than inherited. Inheritance is already
      // correct (state-dir-boot.ts), but one careless `env: {}` here would
      // put every config write back on the operator's ~/.atomic-agent.
      env: agentEnv(),
      ...(cwd ? { cwd } : {}),
    });
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
  // Item 7A: 96, not 64. A model added from Hugging Face is
  // `custom-` + slug.slice(0, 80) (src/local-llm/huggingface-model-def.ts
  // buildCustomModelId), i.e. up to 87 characters — the first real one
  // generated here was 69. At 64 this window refused a perfectly valid id
  // with "not a model id", which reads as if the id were malformed.
  if (!/^[\w.-]{1,96}$/.test(id)) {
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
  // Item 7A: 96 — see modelsUse above (huggingface-model-def.ts:25).
  if (!binary || !/^[\w.-]{1,96}$/.test(id)) {
    return {
      done: Promise.resolve({ ok: false, stdout: "", stderr: "", error: "cannot start the download" }),
      cancel: () => {},
    };
  }
  const child = spawn(binary, ["models", "pull", id], { env: agentEnv(), stdio: ["ignore", "pipe", "pipe"] });
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

/**
 * Item 7A — add a model from Hugging Face. `localModels.customModels` is
 * a list-valued key, so it has no `atag config set <leaf> <value>`
 * spelling: this is the same read-modify-write-the-whole-file move
 * `upsertProvider` makes just above, and for the same reason.
 *
 * Filter-and-append rather than replace-in-place, matching the agent's
 * own `addCustomModel` (src/config/custom-models-store.ts): re-adding the
 * same repo+file is a refresh, and the schema rejects duplicate ids.
 *
 * There is deliberately no remove helper. `atag models remove <custom-id>`
 * deletes the files AND drops the config entry for a custom row
 * (`runLocalModelsRemove`'s `if (wasCustom) removeCustomModel(idArg)`), so
 * the LLM pane's existing `d` key is already the complete removal path.
 */
export async function addCustomModelEntry(
  def: Record<string, unknown>,
): Promise<CliResult> {
  const id = typeof def.id === "string" ? def.id : "";
  if (!/^custom-[a-z0-9._-]+$/.test(id)) {
    return { ok: false, stdout: "", stderr: "", error: `not a custom model id: ${id}` };
  }
  const current = await configGet();
  if (!current.ok || !current.config) {
    return { ok: false, stdout: "", stderr: "", error: current.error ?? "could not read the config" };
  }
  const config = current.config as { localModels?: { customModels?: Array<{ id?: string }> } };
  const localModels = (config.localModels ??= {});
  const kept = (localModels.customModels ?? []).filter((m) => m && m.id !== id);
  localModels.customModels = [...kept, def as { id?: string }];
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
  const key = `${providerId}\n${model}`;
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
    // r5 item 7 (setup wizard): the custom-endpoint branch writes modelId
    // as persistUserRemoteLlmUrls does, so the field has to exist here.
    embeddings?: { url?: string; enabled?: boolean; modelId?: string | null };
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
  // A file without an llm block gets the synthesized one written, as the
  // TUI's writeUserConfigFileSync does unconditionally — even when the id
  // is the block's own default, so the file ends up carrying the block.
  const synthesized = !cfg.llm;
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
  if (llm.activeTextProvider === id && !synthesized) return { ok: true, changed: false };
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

/**
 * persistUserLocalLlmUrl (src/tui/persist-user-local-models-config.ts:110)
 * = persistUserLocalModelsConfig({ url, mode: "external" }), which ends in
 * `parseUserConfigFile(syncLocalLlamaProviderUrl(draft))` — mode, url and
 * the local-llama provider's url move together in ONE file write.
 *
 * Review fix: the External pane used to write `localModels.url` and
 * `localModels.mode` as two leaf `config set` calls and never touched
 * `llm.providers[local-llama].url`, so resolveLlmConfig (which returns the
 * file's llm block verbatim when present) kept routing chat at the old
 * address — the managed port on a file that had been managed — while the
 * pane reported the save as done.
 *
 * The route move itself stays where the TUI puts it (persistLlamaUrl calls
 * `providers.setActiveText` separately, after the probe), so this helper
 * writes exactly what the TUI's persist call writes and nothing more: it
 * does not disable embeddings the way the onboarding wizard's
 * persistUserRemoteLlmUrls does, because this pane never asked about them.
 */
export async function setExternalLlamaUrl(url: string): Promise<WriteResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, changed: false, error: `not a URL: ${url}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, changed: false, error: `not an http(s) URL: ${url}` };
  }
  const read = await readWholeConfig();
  if (!read.ok || !read.config) return { ok: false, changed: false, error: read.error };
  const cfg = read.config;
  const lm = (cfg.localModels ??= {});
  const wasUrl = lm.url;
  const wasMode = lm.mode;
  lm.url = url;
  lm.mode = "external";
  const providerMoved = syncLocalLlamaProviderUrl(cfg);
  if (wasUrl === url && wasMode === "external" && !providerMoved) {
    return { ok: true, changed: false };
  }
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

/**
 * r5 item 9 — the desktop's state dir, and only ever that.
 *
 * This used to fall back to `join(homedir(), ".atomic-agent")`, which was
 * the single hardcoded leak in the whole app: its two readers are the HF
 * 401 hint (main.ts, which names `<stateDir>/.env` on screen) and
 * `keyNamesAvailable` below, which reads `<stateDir>/.env` to decide
 * whether a provider has a key — pointing that at the operator's .env is
 * exactly the key-sharing the user forbade. The resolution now lives in
 * state-dir.ts, and the `~/.atomic-agent` literal is gone from the desktop.
 */
export function stateDirPath(): string {
  return DESKTOP_STATE_DIR;
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

// r5 review fix — exported for tui-import.ts, which has to answer
// "will this provider have a key HERE?" for names the import is about to
// write into the desktop's own .env, not just the ones already resolvable.
export function keyNamesAvailable(): KeyEnvNames {
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


/* item 4 — per-call tool durations from the trace.
   The store stamps one `at` on a call and its result, so it carries no duration.
   The trace writes `llm_completion` when the raw completion arrives and
   `tool_invocation` when that call finishes; their difference (same turn/step,
   nearest preceding in file order) is exactly the interval the TUI's live card
   shows (tool_call_parsed → tool_call_executed). The whole file is read: the
   256 KB tail of traceUsage would lose the early turns of a long session, and a
   readline stream over a missing file can hang instead of rejecting. */
export interface TraceToolRow {
  seq: number;
  turnIndex: number;
  stepIndex: number;
  batchIndex: number;
  tool: string;
  argsKey: string;
  status: string;
  ts: number;
  completionTs: number | null;
  ms: number | null;
}

export async function traceTools(
  stateDir: string,
  sessionId: string,
): Promise<{ ok: boolean; rows?: TraceToolRow[]; error?: string }> {
  if (!/^[\w.-]{1,80}$/.test(sessionId)) return { ok: false, error: "bad session id" };
  if (!stateDir) return { ok: false, error: "no state dir" };
  const file = join(stateDir, "traces", `${sessionId}.ndjson`);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "no trace" };
  }
  const rows: TraceToolRow[] = [];
  // Nearest preceding completion, keyed by turn/step. A parse retry writes a second
  // llm_completion (attempt 2) before the tool row, so "last seen" is the right one.
  // `seq` restarts when a later `serve` appends to the file, so pairing is by file order.
  let lastCompletion: { turnIndex: number; stepIndex: number; ts: number } | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line[0] !== "{") continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const kind = row["type"];
    if (kind === "llm_completion") {
      lastCompletion = { turnIndex: row["turnIndex"] as number, stepIndex: row["stepIndex"] as number, ts: row["ts"] as number };
      continue;
    }
    if (kind !== "tool_invocation") continue;
    const turnIndex = row["turnIndex"] as number;
    const stepIndex = row["stepIndex"] as number;
    const ts = row["ts"] as number;
    const paired =
      lastCompletion && lastCompletion.turnIndex === turnIndex && lastCompletion.stepIndex === stepIndex ? lastCompletion : null;
    rows.push({
      seq: row["seq"] as number,
      turnIndex,
      stepIndex,
      batchIndex: (row["batchIndex"] as number | undefined) ?? 0,
      tool: String(row["tool"] ?? ""),
      argsKey: JSON.stringify(row["args"] ?? {}),
      status: String(row["status"] ?? ""),
      ts,
      completionTs: paired ? paired.ts : null,
      // Never coerce a missing pairing to 0: null means "no measurement".
      ms: paired ? Math.max(0, ts - paired.ts) : null,
    });
  }
  return { ok: true, rows };
}


/* ---------------- Item 7 (settings surface): config unset + task create ---------------- */

/**
 * `atag config get <key>` — one leaf, as the CLI prints it: JSON for
 * booleans/numbers/null, the raw line otherwise. Unlike GET /api/config
 * (the user file verbatim) this is the EFFECTIVE value — the schema default
 * when the user file has no such key — which is what the TUI's panels show.
 */
export async function configGetKey(key: string): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  if (!/^[a-zA-Z][\w.]{0,80}$/.test(key)) return { ok: false, error: `refusing to read a suspicious key: ${key}` };
  const res = await cli(["config", "get", key]);
  if (!res.ok) return { ok: false, error: res.error };
  const raw = res.stdout.trim();
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: true, value: raw };
  }
}

/** `atag config unset <key>` — restores one key to its schema default. */
export async function configUnset(key: string): Promise<CliResult> {
  if (!/^[a-zA-Z][\w.]{0,80}$/.test(key)) {
    return { ok: false, stdout: "", stderr: "", error: `refusing to unset a suspicious key: ${key}` };
  }
  return cli(["config", "unset", key]);
}

export interface TaskCreateInput {
  message: string;
  kind: "cron" | "interval" | "at";
  /** cron expression, interval seconds, or the `at` Unix-ms — already validated by task-schedule.ts. */
  expression: string;
  tz?: string;
}

/**
 * The Tasks tab's "new task". POST /api/tasks on 0.5.4 takes no schedule,
 * so the scheduled form goes through the CLI:
 *   atag task create --message <m> --max-attempts 3 (--cron <expr> [--tz <tz>] | --every <s> | --at <ms>)
 * `--max-attempts 3` matches what the TUI's own create path sets; the
 * record's origin will read `cli` because the CLI has no origin flag.
 * A recurring create boots a runtime inside the CLI, hence the long
 * timeout and the workspace cwd.
 */
export async function taskCreate(
  input: TaskCreateInput,
  cwd?: string,
): Promise<{ ok: boolean; id?: string; record?: unknown; error?: string }> {
  const args = ["task", "create", "--message", input.message, "--max-attempts", "3"];
  if (input.kind === "cron") {
    args.push("--cron", input.expression);
    if (input.tz) args.push("--tz", input.tz);
  } else if (input.kind === "interval") {
    args.push("--every", input.expression);
  } else if (input.kind === "at") {
    args.push("--at", input.expression);
  } else {
    return { ok: false, error: `unknown schedule kind: ${String(input.kind)}` };
  }
  const res = await cli(args, 120_000, cwd);
  if (!res.ok) return { ok: false, error: res.error ?? "task create failed" };
  try {
    const record = JSON.parse(res.stdout) as { id?: string };
    if (typeof record.id !== "string") return { ok: false, error: "task create printed no id" };
    return { ok: true, id: record.id, record };
  } catch {
    return { ok: false, error: `task create did not print JSON: ${res.stdout.trim().slice(0, 200)}` };
  }
}

/* ---------------- Item 7 (settings surface): installed skills incl. disabled ---------------- */

export interface SkillListRow {
  name: string;
  version: string;
  source: string;
  enabled: boolean;
  description: string;
}

/**
 * `atag skill list` — the only surface that lists disabled skills
 * (GET /api/skills is the registry's filtered view). One TSV row per
 * skill: `name\tv<ver>\t[<source>]\t<enabled|disabled>\t<description>`;
 * a `[missing]` row is a disable-list entry that is no longer installed,
 * kept as the CLI prints it (src/cli/skill.ts). Runs with cwd = workspace
 * so project skills are seen.
 */
export async function skillList(cwd?: string): Promise<{ ok: boolean; rows?: SkillListRow[]; error?: string }> {
  const res = await cli(["skill", "list"], 45_000, cwd);
  if (!res.ok) return { ok: false, error: res.error };
  const rows: SkillListRow[] = [];
  for (const line of res.stdout.split("\n")) {
    if (!line.trim() || line.startsWith("(no skills installed)")) continue;
    const cells = line.split("\t");
    if (cells.length < 4) return { ok: false, error: `could not parse skill list line: ${line.slice(0, 120)}` };
    rows.push({
      name: cells[0]!,
      version: (cells[1] ?? "").replace(/^v/, ""),
      source: (cells[2] ?? "").replace(/^\[|\]$/g, ""),
      enabled: cells[3] === "enabled",
      description: cells.slice(4).join("\t"),
    });
  }
  return { ok: true, rows };
}

/* ---------------- Item 7 part B (Skills / Memory / MCP tabs): config paths + skill CLI ---------------- */

const UNSAFE_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/** src/config/config-paths.ts isSafeConfigPath, verbatim. */
function isSafeConfigPath(key: string): boolean {
  return key.split(".").every((s) => !UNSAFE_PATH_SEGMENTS.has(s));
}

/**
 * src/config/config-paths.ts writeConfigPath, verbatim: set `value` at a
 * dotted path in a raw config tree, creating intermediate objects, and
 * refuse `__proto__` / `constructor` / `prototype` segments.
 */
function writeConfigPath(tree: Record<string, unknown>, key: string, value: unknown): void {
  if (!isSafeConfigPath(key)) throw new Error(`config: refusing to write unsafe path ${key}`);
  const segments = key.split(".");
  let node = tree;
  for (const segment of segments.slice(0, -1)) {
    const child = node[segment];
    if (child === null || typeof child !== "object" || Array.isArray(child) || !Object.hasOwn(node, segment)) {
      node[segment] = {};
    }
    node = node[segment] as Record<string, unknown>;
  }
  node[segments[segments.length - 1]!] = value;
}

/**
 * Whole-file write of one dotted key. For the keys the CLI's leaf table
 * does not carry — every `llm.*` key and the list-valued `mcp.servers` on
 * 0.5.4 — the only spelling is `atag config set '<whole json>'`: read the
 * user file, set the path, write it back. The CLI validates the file
 * before writing, so a bad entry comes back as its error text. Read
 * immediately before the write; never from a cached copy.
 */
export async function configSetPath(key: string, value: unknown): Promise<CliResult> {
  if (!/^[a-zA-Z][\w.]{0,80}$/.test(key) || !isSafeConfigPath(key)) {
    return { ok: false, stdout: "", stderr: "", error: `refusing to write a suspicious key: ${key}` };
  }
  const current = await configGet();
  if (!current.ok || !current.config || typeof current.config !== "object") {
    return { ok: false, stdout: "", stderr: "", error: current.error ?? "could not read the config" };
  }
  const tree = current.config as Record<string, unknown>;
  try {
    writeConfigPath(tree, key, value);
  } catch (err) {
    return { ok: false, stdout: "", stderr: "", error: err instanceof Error ? err.message : String(err) };
  }
  return configSetWhole(tree);
}

const SKILL_NAME_RE = /^[\w.-]{1,64}$/;

/**
 * `atag skill show <name>`: the CLI prints `# path: …`, `# source: …`, a
 * blank line, then the whole SKILL.md. The Skills detail for a DISABLED
 * skill comes from here (GET /api/skills/{name} is the registry's
 * filtered view and answers 404). The two header lines are stripped and
 * the frontmatter is cut exactly as parseSkillFile does, so the body
 * matches what the route returns for an enabled skill.
 */
export async function skillShow(
  name: string,
  cwd?: string,
): Promise<{ ok: boolean; body?: string; path?: string; source?: string; error?: string }> {
  if (!SKILL_NAME_RE.test(name)) return { ok: false, error: `not a skill name: ${name}` };
  const res = await cli(["skill", "show", name], 30_000, cwd);
  if (!res.ok) return { ok: false, error: res.error };
  const lines = res.stdout.replace(/\r\n/g, "\n").split("\n");
  let path = "";
  let source = "";
  let i = 0;
  for (; i < lines.length && i < 2; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("# path: ")) path = line.slice("# path: ".length);
    else if (line.startsWith("# source: ")) source = line.slice("# source: ".length);
    else break;
  }
  let content = lines.slice(i).join("\n").replace(/^\n+/, "");
  // parseSkillFile: `---\n` … `\n---`, then the body with leading newlines dropped.
  if (content.startsWith("---\n")) {
    const closing = content.indexOf("\n---", 4);
    if (closing !== -1) content = content.slice(closing + "\n---".length).replace(/^\n+/, "");
  }
  return { ok: true, body: content, path, source };
}

/**
 * `atag skill disable|enable <name>` — the TUI's toggle writes
 * `skills.disabled` in config.json the same way (skills-orchestrator.ts
 * setSkillDisabled). The running `atag serve` keeps its boot-time
 * registry; the tab says so and offers a restart.
 */
export async function skillSetDisabled(name: string, disabled: boolean): Promise<CliResult> {
  if (!SKILL_NAME_RE.test(name)) {
    return { ok: false, stdout: "", stderr: "", error: `not a skill name: ${name}` };
  }
  return cli(["skill", disabled ? "disable" : "enable", name], 30_000);
}

export interface HubSkillRow {
  identifier: string;
  source: "clawhub" | "github";
  downloads: number | null;
  description: string;
}

/**
 * `atag skill browse` / `atag skill search <q>`: one row per hub entry,
 * `[claw]|[gh]\t<identifier>\t↓N|-\t<description>` (src/cli/skill.ts
 * printHubEntries), "(no skills found)" when empty; every `WARN: <repo>:
 * <err>` on stderr becomes the TUI's hubError note. A browse whose every
 * source failed exits 1 with nothing found — reported, not swallowed.
 */
export async function skillBrowse(
  query: string,
  cwd?: string,
): Promise<{ ok: boolean; rows?: HubSkillRow[]; hubError?: string | null; error?: string }> {
  const q = query.trim();
  const res = await cli(q ? ["skill", "search", q] : ["skill", "browse"], 120_000, cwd);
  const warnings = res.stderr
    .split("\n")
    .filter((l) => l.startsWith("WARN: "))
    .map((l) => l.slice("WARN: ".length).trim());
  if (!res.ok && !res.stdout.trim()) {
    return { ok: false, error: warnings.length ? warnings.join("; ") : res.error };
  }
  const rows: HubSkillRow[] = [];
  for (const line of res.stdout.split("\n")) {
    if (!line.trim() || line.startsWith("(no skills found)")) continue;
    const cells = line.split("\t");
    if (cells.length < 3 || (cells[0] !== "[claw]" && cells[0] !== "[gh]")) {
      // A description is printed raw, newlines included (ClawHub summaries carry them): the line continues the previous row.
      const prev = rows[rows.length - 1];
      if (prev && cells.length === 1) { prev.description += "\n" + line; continue; }
      return { ok: false, error: `could not parse skill browse line: ${line.slice(0, 120)}` };
    }
    const dl = cells[2] ?? "-";
    rows.push({
      identifier: cells[1]!,
      source: cells[0] === "[claw]" ? "clawhub" : "github",
      downloads: dl.startsWith("↓") && /^\d+$/.test(dl.slice(1)) ? Number(dl.slice(1)) : null,
      description: cells.slice(3).join("\t"),
    });
  }
  return { ok: true, rows, hubError: warnings.length ? warnings.join("; ") : null };
}

/**
 * `atag skill install <identifier> [--acknowledge-risk]`. A `dangerous`
 * scan verdict makes the CLI exit non-zero with
 * `install blocked: <id> flagged dangerous by the security scan (use
 * --acknowledge-risk to override)` (src/skills/hub/install-from-hub.ts);
 * that comes back as `blocked` so the tab shows the TUI's confirm with
 * the CLI's line as its one finding. Success is the CLI's own
 * `installed <name> (v…) from <id> — <scan summary>` line.
 */
export async function skillInstall(
  identifier: string,
  acknowledgeRisk: boolean,
  cwd?: string,
): Promise<{ ok: boolean; line?: string; blocked?: boolean; message?: string; error?: string }> {
  const id = identifier.trim();
  if (!/^@?[\w.-]+(?:\/[\w.-]+){1,4}$/.test(id)) return { ok: false, error: `not a hub identifier: ${identifier}` };
  const args = ["skill", "install", id];
  if (acknowledgeRisk) args.push("--acknowledge-risk");
  const res = await cli(args, 180_000, cwd);
  if (res.ok) return { ok: true, line: res.stdout.trim().split("\n").pop() ?? "" };
  const message = (res.stderr.trim() || res.error || "install failed").split("\n").pop() ?? "";
  if (/flagged dangerous by the security scan/.test(res.stderr)) return { ok: false, blocked: true, message };
  return { ok: false, error: message };
}

/* ---------------- Item 7 part C (LLM / Telegram / Import tabs): models CLI, import, .env, llama probe ---------------- */

/** Item 7A: 96 — a `custom-` id from the Hugging Face add runs to 87 (huggingface-model-def.ts:25). */
const MODEL_ID_RE = /^[\w.-]{1,96}$/;

export interface ModelsStatus {
  mode: string;
  dataDir: string | null;
  backend: string | null;
  /** First token of the `backend:` line — the tag the TUI prints in `llama.cpp backend [<tag>]`. */
  backendTag: string | null;
  compute: string | null;
  activeModel: string | null;
  activeDownloaded: boolean | null;
  /** `running (pid N)` | `stopped` as the CLI prints it, plus the parsed pid. */
  daemon: string;
  daemonRunning: boolean;
  daemonPid: number | null;
  daemonUrl: string | null;
  health: string | null;
  url: string | null;
}

/**
 * `atag models status` — `mode:`, `data dir:`, `backend:`, `compute:`,
 * `active model:`, `daemon:`, `health:` in managed mode; `mode: external`
 * + `url:` otherwise (src/cli/models-handlers.ts). Parsed by label, never
 * by column.
 */
export async function modelsStatus(): Promise<{ ok: boolean; status?: ModelsStatus; error?: string }> {
  const res = await cli(["models", "status"], 30_000);
  if (!res.ok) return { ok: false, error: res.error };
  const fields: Record<string, string> = {};
  for (const line of res.stdout.split("\n")) {
    const m = line.match(/^([a-z ]+):\s*(.*)$/);
    if (m) fields[m[1]!.trim()] = (m[2] ?? "").trim();
  }
  if (!fields["mode"]) return { ok: false, error: "could not parse models status" };
  const daemonLine = fields["daemon"] ?? "";
  const pid = daemonLine.match(/pid (\d+)/);
  const urlMatch = daemonLine.match(/https?:\/\/\S+/);
  const active = fields["active model"] ?? "";
  const activeId = active.split(/\s+/)[0] || null;
  return {
    ok: true,
    status: {
      mode: fields["mode"]!,
      dataDir: fields["data dir"] || null,
      backend: fields["backend"] || null,
      backendTag: fields["backend"] ? (fields["backend"].split(/\s+/)[0] ?? null) : null,
      compute: fields["compute"] || null,
      activeModel: activeId && activeId !== "(none)" && activeId !== "none" ? activeId : null,
      activeDownloaded: active ? /downloaded/.test(active) && !/not downloaded/.test(active) : null,
      daemon: daemonLine.replace(/\s+https?:\/\/\S+\s*$/, "").trim() || "unknown",
      daemonRunning: /^running/.test(daemonLine),
      daemonPid: pid ? Number(pid[1]) : null,
      daemonUrl: urlMatch ? urlMatch[0] : null,
      health: fields["health"] || null,
      url: fields["url"] || null,
    },
  };
}

export interface EmbeddingCatalogModel {
  id: string;
  size: string;
  dim: string;
  pooling: string;
  downloaded: boolean;
  active: boolean;
}

/**
 * `atag models list-embeddings`: the `ID | SIZE | DIM | POOLING | DL | ACTIVE`
 * table plus the trailer `embedding daemon: <running (pid N)|stopped> on
 * port N, health: <h>`.
 */
export async function modelsListEmbeddings(): Promise<{
  ok: boolean; models?: EmbeddingCatalogModel[]; daemon?: { running: boolean; pid: number | null; port: number | null; health: string }; error?: string;
}> {
  const res = await cli(["models", "list-embeddings"], 45_000);
  if (!res.ok) return { ok: false, error: res.error };
  const models: EmbeddingCatalogModel[] = [];
  let daemon: { running: boolean; pid: number | null; port: number | null; health: string } | undefined;
  for (const line of res.stdout.split("\n")) {
    const trailer = line.match(/^embedding daemon:\s*(.+?) on port (\d+), health: (.*)$/);
    if (trailer) {
      const pid = trailer[1]!.match(/pid (\d+)/);
      daemon = { running: /^running/.test(trailer[1]!), pid: pid ? Number(pid[1]) : null, port: Number(trailer[2]), health: trailer[3]!.trim() };
      continue;
    }
    if (!line.includes("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 5 || cells[0] === "ID" || !cells[0]) continue;
    models.push({
      id: cells[0]!, size: cells[1] ?? "", dim: cells[2] ?? "", pooling: cells[3] ?? "",
      downloaded: (cells[4] ?? "").toLowerCase() === "yes", active: (cells[5] ?? "").includes("*"),
    });
  }
  if (!models.length) return { ok: false, error: "could not parse the embedding catalog" };
  return { ok: true, models, ...(daemon ? { daemon } : {}) };
}

/**
 * The chat route's half of the catalogue.
 *
 * Review fix: `chatModels` used to drop any row whose id merely CONTAINED
 * embed/bge/nomic/jina, which is a guess about names — a chat GGUF named
 * `nomic-*` or `jina-*` would vanish from the local switch and an install
 * holding only that model would report "download model" with a usable model
 * on disk. Which models are embedding models is a fact the CLI publishes:
 * `atag models list-embeddings` IS the embedding catalogue, so subtract it
 * by id. The name test survives only as the fallback for a CLI that cannot
 * answer (an old binary, a parse failure), where a guess beats offering an
 * embedding model to the chat daemon.
 */
export const EMBEDDING_NAME_HINT = /embed|bge|nomic|jina/i;

/** Memoised: one binary's embedding catalogue is static for this process. */
let EMBEDDING_IDS: Promise<Set<string> | null> | null = null;
export function embeddingModelIds(): Promise<Set<string> | null> {
  if (!EMBEDDING_IDS) {
    const p = modelsListEmbeddings()
      .then((r) => (r.ok && r.models ? new Set(r.models.map((m) => m.id)) : null))
      .catch(() => null);
    EMBEDDING_IDS = p;
    // A failed read is not cached: the next caller asks again.
    void p.then((v) => { if (!v && EMBEDDING_IDS === p) EMBEDDING_IDS = null; });
  }
  return EMBEDDING_IDS;
}

export async function chatModelsList(): Promise<{ ok: boolean; models?: CatalogModel[]; error?: string; byCatalog?: boolean }> {
  const list = await modelsList();
  if (!list.ok || !list.models) return list;
  const ids = await embeddingModelIds();
  return ids
    ? { ok: true, models: list.models.filter((m) => !ids.has(m.id)), byCatalog: true }
    : { ok: true, models: list.models.filter((m) => !EMBEDDING_NAME_HINT.test(m.id)), byCatalog: false };
}

// modelsStop: lane C's copy folded into lane B's definition above (identical body).

/** `atag models remove <id>` — chat models only; the CLI refuses an active model while the daemon runs. */
export async function modelsRemove(id: string): Promise<CliResult> {
  if (!MODEL_ID_RE.test(id)) return { ok: false, stdout: "", stderr: "", error: `not a model id: ${id}` };
  return cli(["models", "remove", id], 60_000);
}

/** `atag models pull-embedding <id>`, streamed like `modelsPull`. */
export function modelsPullEmbedding(
  id: string,
  onLine: (line: string) => void,
): { done: Promise<CliResult>; cancel: () => void } {
  const binary = resolveBinary();
  if (!binary || !MODEL_ID_RE.test(id)) {
    return { done: Promise.resolve({ ok: false, stdout: "", stderr: "", error: "cannot start the download" }), cancel: () => {} };
  }
  const child = spawn(binary, ["models", "pull-embedding", id], { env: agentEnv(), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  const relay = (chunk: Buffer, sink: "out" | "err") => {
    const text = chunk.toString("utf8");
    if (sink === "out") stdout += text; else stderr += text;
    for (const line of text.split(/[\r\n]/)) if (line.trim()) onLine(line.trim());
  };
  child.stdout.on("data", (c: Buffer) => relay(c, "out"));
  child.stderr.on("data", (c: Buffer) => relay(c, "err"));
  const done = new Promise<CliResult>((resolve) => {
    child.on("exit", (code) => resolve(code === 0 ? { ok: true, stdout, stderr } : { ok: false, stdout, stderr, error: `download exited with code ${code ?? "null"}` }));
    child.on("error", (err) => resolve({ ok: false, stdout, stderr, error: err.message }));
  });
  return { done, cancel: () => child.kill("SIGTERM") };
}

/** `atag models use-embedding <id>` or `--disable`. */
export async function modelsUseEmbedding(idOrDisable: string): Promise<CliResult> {
  if (idOrDisable !== "--disable" && !MODEL_ID_RE.test(idOrDisable)) {
    return { ok: false, stdout: "", stderr: "", error: `not an embedding model id: ${idOrDisable}` };
  }
  return cli(["models", "use-embedding", idOrDisable], 60_000);
}

/** `atag models update` — downloads the latest backend; stops the daemon first. */
export async function modelsUpdate(): Promise<CliResult> {
  return cli(["models", "update"], 300_000);
}

export interface GpuDevice { id: string; vram: string; name: string; active: boolean }

/** `atag models devices`: `configured device:`, `effective device:`, then the `ID | VRAM | DEVICE` table (`*` marks the active one). */
export async function modelsDevices(): Promise<{ ok: boolean; configured?: string; effective?: string; devices?: GpuDevice[]; error?: string }> {
  const res = await cli(["models", "devices"], 60_000);
  if (!res.ok) return { ok: false, error: res.error };
  const devices: GpuDevice[] = [];
  let configured = "";
  let effective = "";
  for (const line of res.stdout.split("\n")) {
    const c = line.match(/^configured device:\s*(.*)$/);
    if (c) { configured = c[1]!.trim(); continue; }
    const e = line.match(/^effective device:\s*(.*)$/);
    if (e) { effective = e[1]!.trim(); continue; }
    if (!line.includes("|")) continue;
    const cells = line.split("|").map((x) => x.trim());
    if (cells.length < 3 || cells[0] === "ID" || !cells[0]) continue;
    const active = cells[0]!.startsWith("*");
    devices.push({ id: cells[0]!.replace(/^\*\s*/, ""), vram: cells[1] ?? "", name: cells[2] ?? "", active });
  }
  return { ok: true, configured, effective, devices };
}

export async function modelsUseDevice(id: string): Promise<CliResult> {
  if (!/^[\w.-]{1,32}$/.test(id)) return { ok: false, stdout: "", stderr: "", error: `not a device id: ${id}` };
  return cli(["models", "use-device", id], 30_000);
}

/* r5 item 7 (setup wizard): the first-run import step offers all four
   sources the agent's own `atag import` accepts (src/cli/import-command.ts
   importCommand), not the two the Import tab was written for. The domain
   whitelist below is per source, from the four registries in
   the import-options.ts files under src/import — with one whitelist for all four an
   unticked `skills` on Claude Code was dropped from --exclude and the dry
   run previewed more than the operator ticked. */
export type ImportSourceId = "hermes" | "openclaw" | "claude-code" | "codex";
/** Domain ids each source's resolver understands, from its import-options.ts. */
export const IMPORT_DOMAINS: Record<ImportSourceId, readonly string[]> = {
  hermes: ["sessions", "cron", "secrets"],
  openclaw: ["sessions", "cron"],
  "claude-code": ["skills", "memory", "mcp", "sessions", "secrets"],
  codex: ["skills", "memory", "sessions", "secrets"],
};
/** Sources whose CLI leg accepts `--migrate-secrets` (import-command.ts:128, :332, :446). */
const IMPORT_SECRET_SOURCES: readonly ImportSourceId[] = ["hermes", "claude-code", "codex"];

export interface ImportRunInput {
  source: ImportSourceId;
  dir: string;
  exclude: string[];
  secrets: boolean;
  overwrite: boolean;
  limit: string;
  execute: boolean;
}
export interface ImportItem { kind: string; status: string; source: string | null; destination: string | null; reason: string | null }
export interface ImportReportParsed { items: ImportItem[]; summary: { migrated: number; skipped: number; conflict: number; error: number } }

/**
 * `atag import <hermes|openclaw|claude-code|codex> --source <dir>
 * [--exclude a,b] [--migrate-secrets] [--overwrite] [--limit N]
 * (--dry-run | --yes)`, built on its own so the source guard, the
 * per-source `--exclude` whitelist and the `--migrate-secrets` gate can be
 * asserted without a child process — the three things that decide whether
 * a preview promises more than the operator ticked (review fix: they had
 * no coverage, and no UI produces a non-default option set for the two
 * newer sources, so a spawned run cannot reach them).
 */
export function importArgs(input: ImportRunInput): { ok: true; args: string[] } | { ok: false; error: string } {
  const domains = IMPORT_DOMAINS[input.source as ImportSourceId];
  if (!domains) return { ok: false, error: "source must be hermes, openclaw, claude-code or codex" };
  const dir = input.dir.trim();
  if (!dir) return { ok: false, error: "source dir is empty" };
  const args = ["import", input.source, "--source", dir];
  const exclude = input.exclude.filter((x) => domains.includes(x));
  if (exclude.length) args.push("--exclude", exclude.join(","));
  if (input.secrets && IMPORT_SECRET_SOURCES.includes(input.source)) args.push("--migrate-secrets");
  if (input.overwrite) args.push("--overwrite");
  const limit = input.limit.trim();
  if (limit) {
    if (!/^\d+$/.test(limit)) return { ok: false, error: "limit must be a non-negative integer" };
    args.push("--limit", limit);
  }
  args.push(input.execute ? "--yes" : "--dry-run");
  return { ok: true, args };
}

/**
 * Run it. Exactly one of `--dry-run` / `--yes` is always passed: without
 * either, a non-TTY run prints "Non-interactive: …" and exits 0 having
 * written nothing (src/cli/import-command.ts). The report block
 * (`  [<kind>] <status> <src -> dst>( (<reason>))` … `  ----` …
 * `  migrated=… skipped=… conflict=… error=…`) is parsed into the TUI's
 * rows; `state` names what the run did.
 */
export async function importRun(input: ImportRunInput, cwd?: string): Promise<{
  ok: boolean; state?: "preview" | "applied" | "nothing" | "non-interactive"; report?: ImportReportParsed; stdout?: string; stderr?: string; error?: string;
}> {
  const built = importArgs(input);
  if (!built.ok) return { ok: false, error: built.error };
  const args = built.args;
  const res = await cli(args, 300_000, cwd);
  if (!res.ok && !res.stdout.trim()) return { ok: false, error: res.error, stdout: res.stdout, stderr: res.stderr };
  const lines = res.stdout.replace(/\r\n/g, "\n").split("\n");
  // The block after the LAST `Preview:` / `Result:` header is the one that describes what happened.
  let start = -1;
  lines.forEach((l, i) => { if (l === "Preview:" || l === "Result:") start = i; });
  const items: ImportItem[] = [];
  let summary = { migrated: 0, skipped: 0, conflict: 0, error: 0 };
  let sawSummary = false;
  if (start >= 0) {
    for (const line of lines.slice(start + 1)) {
      const s = line.match(/^\s*migrated=(\d+) skipped=(\d+) conflict=(\d+) error=(\d+)\s*$/);
      if (s) { summary = { migrated: +s[1]!, skipped: +s[2]!, conflict: +s[3]!, error: +s[4]! }; sawSummary = true; break; }
      const m = line.match(/^\s*\[([^\]]+)\]\s+(\S+)\s*(.*)$/);
      if (!m) continue;
      let rest = m[3]!.trim();
      let reason: string | null = null;
      if (rest.startsWith("(") && rest.endsWith(")")) { reason = rest.slice(1, -1); rest = ""; }
      else { const r = rest.match(/^(.*?)\s\((.*)\)$/); if (r) { rest = r[1]!; reason = r[2]!; } }
      let source: string | null = null;
      let destination: string | null = null;
      if (rest) {
        const arrow = rest.indexOf(" -> ");
        if (arrow >= 0) { source = rest.slice(0, arrow); destination = rest.slice(arrow + 4); }
        else source = rest;
      }
      items.push({ kind: m[1]!, status: m[2]!, source, destination, reason });
    }
  }
  if (!sawSummary) return { ok: false, error: res.error ?? `could not parse the import report: ${res.stdout.trim().slice(0, 200)}`, stdout: res.stdout, stderr: res.stderr };
  const state = res.stdout.includes("Non-interactive:") ? "non-interactive"
    : res.stdout.includes("Nothing to import.") ? "nothing"
      : lines.includes("Result:") ? "applied" : "preview";
  return { ok: true, state, report: { items, summary }, stdout: res.stdout, stderr: res.stderr };
}

/**
 * Tail of `<dataDir>/llama-server.log` (src/local-llm/backend-paths.ts),
 * the file behind the TUI's "LLM logs" tab: the last 64 KB, the size and
 * whether the read was truncated. `path: null` when the file does not
 * exist yet — the panel prints its "waiting for the first daemon start" line.
 */
export function llamaLogTail(dataDir: string): { ok: boolean; path: string | null; size: number | null; truncated: boolean; text: string; lastReadAt: number; error?: string } {
  const file = join(dataDir, "llama-server.log");
  try {
    const size = statSync(file).size;
    const from = Math.max(0, size - 64 * 1024);
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(size - from);
      readSync(fd, buf, 0, buf.length, from);
      return { ok: true, path: file, size, truncated: from > 0, text: buf.toString("utf8"), lastReadAt: Date.now() };
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: true, path: null, size: null, truncated: false, text: "", lastReadAt: Date.now() };
    return { ok: false, path: file, size: null, truncated: false, text: "", lastReadAt: Date.now(), error: err instanceof Error ? err.message : String(err) };
  }
}

/* .env — the same conventions as src/config/load-dotenv.ts and
   src/config/dotenv-writer.ts. Only key NAMES ever cross to the renderer. */

const DOTENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const SECRET_FILE_MODE = 0o600;

/** Names of the keys `<stateDir>/.env` carries (load-dotenv.ts parseLine: trimmed, `#` comments, `KEY=…`). Never values. */
export function dotenvKeys(stateDir: string): { ok: boolean; keys: string[]; exists: boolean; error?: string } {
  const path = join(stateDir, ".env");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, keys: [], exists: false };
    return { ok: false, keys: [], exists: true, error: err instanceof Error ? err.message : String(err) };
  }
  const keys: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (DOTENV_KEY_PATTERN.test(key) && !keys.includes(key)) keys.push(key);
  }
  return { ok: true, keys, exists: true };
}

/** Which of `names` are set (non-empty) in this process's environment — the other half of the TUI's `process.env` view. Names only. */
export function envPresent(names: string[]): string[] {
  return names.filter((n) => DOTENV_KEY_PATTERN.test(n) && typeof process.env[n] === "string" && process.env[n]!.trim().length > 0);
}

/**
 * src/config/dotenv-writer.ts setDotenvKey, ported verbatim: atomic
 * `tmp` + `rename`, mode 0600, comments/blank lines/ordering preserved,
 * quoting for values with whitespace or shell-special characters so
 * `loadDotenvFromStateDir` reads the same string back, `null` removes the
 * key (and unlinks a file that becomes empty). Never logs the value.
 */
export function dotenvSet(stateDir: string, key: string, value: string | null): { ok: boolean; path: string; preexisting: boolean; changed: boolean; error?: string } {
  const path = join(stateDir, ".env");
  if (!DOTENV_KEY_PATTERN.test(key)) return { ok: false, path, preexisting: false, changed: false, error: `invalid key '${key}'` };
  try {
    const existed = existsSync(path);
    const original = existed ? readFileSync(path, "utf8") : "";
    const updated = applyDotenvMutation(original, key, value);
    if (updated === null) return { ok: true, path, preexisting: existed, changed: false };
    if (updated === original && existed) return { ok: true, path, preexisting: true, changed: false };
    if (updated.length === 0) {
      if (existed) unlinkSync(path);
      return { ok: true, path, preexisting: existed, changed: existed };
    }
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, updated, { encoding: "utf8", mode: SECRET_FILE_MODE });
    try {
      renameSync(tmp, path);
    } catch (err) {
      try { unlinkSync(tmp); } catch { /* best effort */ }
      throw err;
    }
    try { chmodSync(path, SECRET_FILE_MODE); } catch { /* best effort on platforms without chmod */ }
    return { ok: true, path, preexisting: existed, changed: true };
  } catch (err) {
    return { ok: false, path, preexisting: false, changed: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function applyDotenvMutation(original: string, key: string, value: string | null): string | null {
  const lines = original.length === 0 ? [] : original.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  let foundIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (dotenvLineMatchesKey(lines[i] ?? "", key)) { foundIndex = i; break; }
  }
  if (value === null) {
    if (foundIndex === -1) return null;
    lines.splice(foundIndex, 1);
    return joinDotenvLines(lines);
  }
  const formatted = `${key}=${formatDotenvValue(value)}`;
  if (foundIndex === -1) lines.push(formatted);
  else lines[foundIndex] = formatted;
  return joinDotenvLines(lines);
}

function dotenvLineMatchesKey(line: string, key: string): boolean {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("#")) return false;
  const eq = trimmed.indexOf("=");
  if (eq === -1) return false;
  return trimmed.slice(0, eq).trim() === key;
}

function formatDotenvValue(value: string): string {
  if (value.length === 0) return "";
  if (/[\s"'#\\]/.test(value)) {
    if (value.includes('"') && !value.includes("'")) return `'${value}'`;
    const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `"${escaped}"`;
  }
  return value;
}

function joinDotenvLines(lines: string[]): string {
  if (lines.length === 0) return "";
  return `${lines.join("\n")}\n`;
}

/* External llama.cpp probe — src/llm/llama-server-health.ts checkLlamaServer
   (retries 0, verifyAuth) + describe-llama-health-failure.ts, run in the
   main process because the renderer cannot fetch. */

export interface LlamaProbeResult {
  reachable: boolean;
  status: number | null;
  kind: "llama-server" | "llama-loading" | "openai-compat" | "llama-auth" | "unknown";
  error: string | null;
  latencyMs: number;
  /** describeLlamaHealthFailure(): the line the operator can act on; null when reachable. */
  message: string | null;
  ollama: boolean;
}

/** src/llm/llama-endpoint-url.ts llamaEndpointUrl, verbatim. */
function llamaEndpointUrl(base: string, endpointPath: string): string {
  const parsed = new URL(base);
  let basePath = parsed.pathname.replace(/\/+$/, "");
  if (basePath.toLowerCase().endsWith("/v1")) basePath = basePath.slice(0, -"/v1".length);
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = `${basePath}${endpointPath}`;
  return parsed.toString();
}

/** src/tui/persist-user-local-models-config.ts normalizeLocalLlmBaseUrl. */
export function normalizeLocalLlmBaseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try { new URL(withScheme); } catch { return null; }
  return withScheme;
}

function looksLikeOllamaUrl(url: string): boolean {
  try { return new URL(url).port === "11434"; } catch { return false; }
}

/** src/tui/providers/is-local-provider-url.ts: loopback hosts. */
function isLocalProviderUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]" || host === "0.0.0.0";
  } catch { return false; }
}

function bodyLooksLikeLlamaHealth(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && typeof (parsed as { status?: unknown }).status === "string";
  } catch { return false; }
}

function bodyLooksLikeLlamaLoading(text: string): boolean {
  if (bodyLooksLikeLlamaHealth(text)) return true;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return false;
    const error = (parsed as { error?: unknown }).error;
    if (typeof error !== "object" || error === null) return false;
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" && message.toLowerCase().includes("loading");
  } catch { return false; }
}

function describeLlamaHealthFailure(kind: LlamaProbeResult["kind"], error: string | null, url: string): string {
  switch (kind) {
    case "openai-compat":
      if (looksLikeOllamaUrl(url)) {
        return isLocalProviderUrl(url)
          ? `${url} answers like Ollama (its default port), not llama.cpp. Add it as a cloud provider instead: LLM tab › Cloud › n › Ollama (local), base URL ${url}.`
          : `${url} answers like Ollama (its default port), not llama.cpp. Add it as a cloud provider instead: LLM tab › Cloud › n › openai-compatible, base URL ${url} (any API key value passes — a stock Ollama has no auth).`;
      }
      return `${url} answers like an OpenAI-compatible server, not llama.cpp. Add it as a cloud provider instead: LLM tab › Cloud › n › openai-compatible, base URL ${url}.`;
    case "llama-loading":
      return `${url} is a llama.cpp server still loading its model. Give it a minute and save the URL again.`;
    case "llama-auth":
      return `${url}: ${error ?? "http 401 — API key required"}. Set ATOMIC_AGENT_LLAMA_API_KEY in the state dir's .env and retry.`;
    default:
      return `local-llm /health failed at ${url}: ${error ?? "unknown"}`;
  }
}

export async function llamaProbe(rawUrl: string, timeoutMs = 8000): Promise<{ ok: boolean; url?: string; probe?: LlamaProbeResult; error?: string }> {
  const url = normalizeLocalLlmBaseUrl(rawUrl);
  if (!url) return { ok: false, error: "invalid URL" };
  const apiKey = process.env["ATOMIC_AGENT_LLAMA_API_KEY"] || null;
  const headers: Record<string, string> = { accept: "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
  const start = Date.now();
  let result: LlamaProbeResult;
  try {
    const response = await fetch(llamaEndpointUrl(url, "/health"), { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      if (response.status === 503 && bodyLooksLikeLlamaLoading(text)) {
        result = { reachable: false, status: 503, kind: "llama-loading", error: "llama.cpp is still loading the model", latencyMs: Date.now() - start, message: null, ollama: false };
      } else {
        result = { reachable: false, status: response.status, kind: "unknown", error: `http ${response.status}`, latencyMs: Date.now() - start, message: null, ollama: false };
      }
    } else {
      const isLlama = bodyLooksLikeLlamaHealth(text);
      result = { reachable: isLlama, status: response.status, kind: isLlama ? "llama-server" : "unknown", error: isLlama ? null : "answered 200 but not with llama.cpp's /health shape", latencyMs: Date.now() - start, message: null, ollama: false };
    }
  } catch (err) {
    result = { reachable: false, status: null, kind: "unknown", error: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - start, message: null, ollama: false };
  }
  if (result.reachable) {
    // verifyAuth: the key-guarded /props; only an explicit 401/403 flips the verdict.
    try {
      const response = await fetch(llamaEndpointUrl(url, "/props"), { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) });
      if (response.status === 401 || response.status === 403) {
        result = { ...result, reachable: false, status: response.status, kind: "llama-auth",
          error: apiKey ? `http ${response.status} — the server rejected the configured API key` : `http ${response.status} — the server requires an API key (--api-key)` };
      }
    } catch { /* keep the passing /health */ }
  } else if (result.kind === "unknown" && (result.status === 200 || result.status === 404)) {
    try {
      const response = await fetch(llamaEndpointUrl(url, "/v1/models"), { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok) {
        const parsed: unknown = JSON.parse(await response.text());
        if (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { data?: unknown }).data)) result = { ...result, kind: "openai-compat" };
      }
    } catch { /* stays unknown */ }
  }
  result.ollama = looksLikeOllamaUrl(url);
  if (!result.reachable) result.message = describeLlamaHealthFailure(result.kind, result.error, url);
  return { ok: true, url, probe: result };
}


/* ================================================================
   r5 item 7 — setup wizard: the three main-process legs the ported
   first-run flow needs and the desktop did not have.
   ================================================================ */

/**
 * `atag models update`, STREAMED — the runtime phase of the download.
 *
 * The buffered `modelsUpdate()` above resolves only at the end, so a
 * bar driven from it would sit at 0% for the whole backend zip. This is
 * the same spawn/relay shape `modelsPull` uses, and the two feed one
 * `cli:pull` stream so the strip has one parser.
 *
 * Honest limit, carried through to the screen: `runLocalModelsUpdate`
 * (src/cli/models-handlers.ts:734-745) returns 0 WITHOUT downloading
 * anything when `checkForBackendUpdate` says the tag on disk is current
 * — it prints `backend up to date (<tag>)` or `backend unchanged …`.
 * A machine whose binary is missing but whose version file matches gets
 * no bytes, so the caller must not draw a runtime bar it is not driving;
 * `sawProgress` on the result says whether any were.
 */
export function modelsUpdateStream(
  onLine: (line: string) => void,
): { done: Promise<CliResult & { sawProgress: boolean; upToDate: boolean }>; cancel: () => void } {
  const binary = resolveBinary();
  if (!binary) {
    return {
      done: Promise.resolve({ ok: false, stdout: "", stderr: "", error: "no atomic-agent binary found", sawProgress: false, upToDate: false }),
      cancel: () => {},
    };
  }
  /* r5 integration: `env: agentEnv()` like every other spawn in this file.
     Without it the wizard's runtime download runs `models update` against the
     OPERATOR's ~/.atomic-agent — it writes the llama.cpp backend into whatever
     state dir the child resolves, which is exactly what item 9 exists to stop.
     The isolation lane's source scan is what caught it. */
  const child = spawn(binary, ["models", "update"], { env: agentEnv(), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let sawProgress = false;
  const relay = (chunk: Buffer, sink: "out" | "err") => {
    const text = chunk.toString("utf8");
    if (sink === "out") stdout += text;
    else stderr += text;
    for (const line of text.split(/[\r\n]/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/^\[[= ]{20}\]\s+\d{1,3}%/.test(trimmed)) sawProgress = true;
      onLine(trimmed);
    }
  };
  child.stdout.on("data", (c: Buffer) => relay(c, "out"));
  child.stderr.on("data", (c: Buffer) => relay(c, "err"));
  const done = new Promise<CliResult & { sawProgress: boolean; upToDate: boolean }>((resolve) => {
    const finish = (base: CliResult) =>
      resolve({
        ...base,
        sawProgress,
        upToDate: /backend up to date|backend unchanged/.test(stdout),
      });
    child.on("exit", (code) =>
      finish(
        code === 0
          ? { ok: true, stdout, stderr }
          : { ok: false, stdout, stderr, error: `models update exited with code ${code ?? "null"}` },
      ),
    );
    child.on("error", (err) => finish({ ok: false, stdout, stderr, error: err.message }));
  });
  return { done, cancel: () => child.kill("SIGTERM") };
}

/**
 * persistUserRemoteLlmUrls (src/tui/persist-user-local-models-config.ts:113-169)
 * as ONE whole-file write.
 *
 * Not `setExternalLlamaUrl` above: that one writes the chat half only,
 * which is right for the External pane (it never asked about embeddings)
 * and wrong here — the first-run custom-endpoint branch answers both
 * questions, and leaving `localModels.embeddings` pointed at the managed
 * port would keep the embedding daemon addressed at a port nothing is
 * serving. The routing half (`llm.activeTextProvider`) is written too,
 * with the TUI's own reason: without it a file whose `llm` block names
 * some other provider keeps it, and the wizard has written an address
 * nothing uses.
 */
export async function setExternalLlamaUrls(input: {
  chatUrl: string;
  embeddingUrl?: string;
}): Promise<WriteResult> {
  const check = (raw: string): string | null => {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return `not a URL: ${raw}`;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return `not an http(s) URL: ${raw}`;
    return null;
  };
  const chatBad = check(input.chatUrl);
  if (chatBad) return { ok: false, changed: false, error: chatBad };
  const hasEmbedding = typeof input.embeddingUrl === "string" && input.embeddingUrl.length > 0;
  if (hasEmbedding) {
    const embBad = check(input.embeddingUrl!);
    if (embBad) return { ok: false, changed: false, error: embBad };
  }
  const read = await readWholeConfig();
  if (!read.ok || !read.config) return { ok: false, changed: false, error: read.error };
  const cfg = read.config;
  const lm = (cfg.localModels ??= {});
  lm.mode = "external";
  lm.url = input.chatUrl;
  const emb = (lm.embeddings ??= {});
  emb.enabled = hasEmbedding;
  // The TUI's own default: an embedding URL with no model id named yet
  // gets the catalog default (models-catalog.ts DEFAULT_EMBEDDING_MODEL_ID).
  emb.modelId = hasEmbedding ? (emb.modelId ?? "nomic-embed-text-v1.5") : null;
  if (hasEmbedding) emb.url = input.embeddingUrl!;
  const mem = (cfg.memory ??= {});
  const memEmb = (mem.embeddings ??= {});
  memEmb.enabled = hasEmbedding;
  // Only when the file already carries an llm block, exactly as the TUI
  // gates it: a file without one already routes at local-llama through
  // the synthesized default entry.
  if (cfg.llm) {
    cfg.llm.activeTextProvider = "local-llama";
    const providers = (cfg.llm.providers ??= []);
    if (!providers.some((p) => p.id === "local-llama")) {
      providers.push({ id: "local-llama", kind: "llama-server", url: input.chatUrl } as ProviderEntry);
    }
  }
  syncLocalLlamaProviderUrl(cfg);
  const w = await configSetWhole(cfg);
  return w.ok ? { ok: true, changed: true } : { ok: false, changed: false, error: w.error };
}

/**
 * src/import/detect-import-agents.ts, transcribed: the four sources, the
 * `*_STATE_DIR` env overrides, and the same shallow existsSync artefact
 * checks — "does the state dir hold at least one thing this importer
 * reads", never opening a database.
 */
export interface DetectedImportAgentRow { id: ImportSourceId; label: string; dir: string }

const IMPORT_AGENT_LABELS: Record<ImportSourceId, string> = {
  hermes: "Hermes",
  openclaw: "OpenClaw",
  "claude-code": "Claude Code",
  codex: "Codex",
};

export function importAgentDir(id: ImportSourceId, home = homedir(), env = process.env): string {
  switch (id) {
    case "hermes":
      return env["HERMES_STATE_DIR"] ?? join(home, ".hermes");
    case "openclaw":
      return env["OPENCLAW_STATE_DIR"] ?? join(home, ".openclaw");
    case "claude-code":
      return env["CLAUDE_CODE_STATE_DIR"] ?? join(home, ".claude");
    case "codex":
      return env["CODEX_STATE_DIR"] ?? join(home, ".codex");
  }
}

function hasImportableState(id: ImportSourceId, dir: string): boolean {
  switch (id) {
    case "hermes":
      return existsSync(join(dir, "state.db")) || existsSync(join(dir, "cron", "jobs.json"));
    case "openclaw":
      return existsSync(join(dir, "agents")) || existsSync(join(dir, "state", "openclaw.sqlite"));
    case "claude-code":
      return (
        existsSync(join(dir, "projects")) ||
        existsSync(join(dir, "skills")) ||
        existsSync(join(dir, "settings.json"))
      );
    case "codex":
      return (
        existsSync(join(dir, "sessions")) ||
        existsSync(join(dir, "skills")) ||
        existsSync(join(dir, "auth.json")) ||
        existsSync(join(dir, "AGENTS.md"))
      );
  }
}

export function detectImportAgents(): DetectedImportAgentRow[] {
  const rows: DetectedImportAgentRow[] = [];
  for (const id of Object.keys(IMPORT_AGENT_LABELS) as ImportSourceId[]) {
    const dir = importAgentDir(id);
    if (!hasImportableState(id, dir)) continue;
    rows.push({ id, label: IMPORT_AGENT_LABELS[id], dir });
  }
  return rows;
}
