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
