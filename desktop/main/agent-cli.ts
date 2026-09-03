import { execFile, spawn } from "node:child_process";
import { totalmem } from "node:os";
import { closeSync, openSync, readSync, statSync } from "node:fs";
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

async function cli(args: string[], timeout = 30_000, cwd?: string): Promise<CliResult> {
  const binary = resolveBinary();
  if (!binary) return { ok: false, stdout: "", stderr: "", error: "no atomic-agent binary found" };
  try {
    const { stdout, stderr } = await run(binary, args, {
      timeout,
      maxBuffer: 8 * 1024 * 1024,
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
  return cli(["models", "use", id], 60_000);
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
  apiKey?: string;
  apiKeyEnvVar?: string;
  apiKeyHeader?: string;
  headers?: Record<string, string>;
  defaultChatModel?: string;
}

async function configSetWhole(config: unknown): Promise<CliResult> {
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

/* ---------------- Item 7 (settings surface): config unset + task create ---------------- */

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
