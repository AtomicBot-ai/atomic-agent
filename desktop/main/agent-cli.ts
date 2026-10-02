import { execFile, spawn } from "node:child_process";
// r5 integration: `homedir` is back for the wizard's import scan only — it
// locates the OTHER agents' state dirs (~/.claude, ~/.codex …), never this
// desktop's own, which is DESKTOP_STATE_DIR (item 9).
import { homedir, totalmem } from "node:os";
import { closeSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
// Item 7 part C (LLM / Telegram / Import tabs): the .env writer and llama log tail.
import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";

import { commandOf, resolveBinary } from "./agent-client.js";
// r5 item 9 — every `atag` subprocess runs on the DESKTOP's state directory.
import { agentEnv, DESKTOP_STATE_DIR } from "./state-dir.js";
import { localLlamaKeyFor, managedDataDir } from "./local-llama-key.js";

// Moved next to the key lookup that needs it; main.ts still imports it from here.
export { managedDataDir } from "./local-llama-key.js";
// r7 models — the description + RAM figures `atag models list` cannot print.
import { curatedMeta } from "./model-catalog.js";
import { pruneIncompleteProviders } from "./provider-hygiene.js";

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

/**
 * What a failed `atag` run said, as a line a person can read: the agent's
 * own message without the stack frames under it. A thrown error prints
 * `Error: ENOENT … at statSync (node:fs…) at readLogTail (file:///…)`, and
 * the Models pane put all of it in a red banner on a fresh install. The
 * full stderr still travels in `CliResult.stderr` for the logs.
 */
export function plainCliError(stderr: string): string {
  const frame = /^\s*at\s(?:.*(?:file:\/\/|node:|\/|\\).*:\d+(?::\d+)?\)?|.*\((?:index \d+|<anonymous>)\))\s*$/;
  return stderr.split("\n")
    .filter((l) => !frame.test(l) && !/^\s*Node\.js v\d+\.\d+/.test(l))
    .join("\n").trim();
}

async function cli(args: string[], timeout = 30_000, cwd?: string, signal?: AbortSignal): Promise<CliResult> {
  const binary = resolveBinary();
  if (!binary) return { ok: false, stdout: "", stderr: "", error: "no atomic-agent binary found" };
  try {
    const { stdout, stderr } = await run(binary, args, {
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      // Windows: no console window flashing up for every config read.
      windowsHide: true,
      // r5 item 9: named rather than inherited. Inheritance is already
      // correct (state-dir-boot.ts), but one careless `env: {}` here would
      // put every config write back on the operator's ~/.atomic-agent.
      env: agentEnv(),
      ...(cwd ? { cwd } : {}),
      ...(signal ? { signal } : {}),
    });
    return { ok: true, stdout, stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean; code?: string | number };
    // Item 11: killed on purpose (a stop superseded the start), not timed out.
    if (signal?.aborted) {
      return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? "", error: `\`atag ${args.slice(0, 2).join(" ")}\` was stopped before it finished` };
    }
    /* r6 (human-scenario round): say what went wrong, in words.
       When `execFile` kills a child on `timeout`, its message is the whole
       command line — the wizard printed
       "Command failed: /Users/<you>/atag-agent/bin/atag config get"
       in red under the API-key box and stopped there. That is not a sentence
       a person can act on: it names a path they did not type and a subcommand
       they did not run, and it says nothing about the one thing that actually
       happened, which is that the agent did not answer in time. A driven
       first-run hit exactly this on a loaded machine and had nowhere to go.
       So: name the deadline when we killed it, and otherwise prefer the
       agent's own stderr over execFile's echo of the command line. */
    /* Only the verb is ever quoted back. `config set` is handed a whole
       config document as one argument (setWholeConfig below) and that
       document carries provider API keys — echoing the argv into an error
       string that ends up on screen and in the log would spill one. */
    const verb = `atag ${args.slice(0, 2).join(" ")}`.trim();
    if (e.killed || e.code === "ETIMEDOUT") {
      const detail = e.stderr?.trim();
      return {
        ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? "",
        error: `the agent did not answer \`${verb}\` within ${Math.round(timeout / 1000)}s`
          + ` — it may be busy or starting up. Try again.${detail ? ` (${detail.slice(0, 200)})` : ""}`,
      };
    }
    const said = plainCliError(e.stderr ?? "");
    return {
      ok: false,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      error: said
        || (e.message?.startsWith("Command failed")
          ? `\`${verb}\` failed without saying why${typeof e.code === "number" ? ` (exit ${e.code})` : ""}`
          : e.message)
        || "command failed",
    };
  }
}

/* ---------------------------------------------------------------
   ONE CONFIG WRITER AT A TIME.

   Every whole-file helper below is a read-modify-write: `config get`,
   change one branch of the tree, `config set '<the whole json>'`. A
   second write that lands BETWEEN that read and that write is not
   merged — it is overwritten by a snapshot taken before it existed.

   That is not theoretical. Driven on a fresh state dir (r8 review), with
   config.json read ten times a second: clicking "Local models" fires
   `useManagedMode()` and, in the same tick, the wizard stamps
   `tui.onboarding.localSetupSeenAt` through the leaf `config set`. The
   file showed the stamp arrive at +10.1s and vanish at +10.8s, replaced
   by the managed-mode write built from the pre-stamp snapshot. The lost
   stamp is what `obDecideSecondBackend` reads to decide whether the
   local half of setup has been seen, so the flow re-pitched a setup
   screen to an operator who had just walked through one. Lane D of
   `test/wizard-resume.drive.mjs` reads that leaf back off disk at the end
   of a real first run, which is the check that keeps this honest.

   So all of this module's config writes queue on one chain: a
   read-modify-write holds it across BOTH legs, and a leaf write waits
   its turn. Reads that are not part of a mutation are not gated — they
   only ever see a whole file, never a half-written one, because the CLI
   writes it in one call.

   The limit, said out loud: this serializes the writes THIS process
   makes. `models pull` and `models update` are minutes-long children
   that write the file themselves, and nothing here can hold a lock
   across them; `models use` is short enough to hold and is held, since
   the desktop follows it with a write of its own that must not race it.
*/
let configWriteChain: Promise<void> = Promise.resolve();
/** Run `write` with the config file to itself; every writer here queues on this. */
export function withConfigLock<T>(write: () => Promise<T>): Promise<T> {
  const next = configWriteChain.then(write, write);
  configWriteChain = next.then(() => undefined, () => undefined);
  return next;
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
  return withConfigLock(() => cli(["config", "set", key, value]));
}

export interface CatalogModel {
  id: string;
  family: string;
  size: string;
  context: string;
  downloaded: boolean;
  active: boolean;
  /* ---- the vendored catalogue metadata, when this id is one the table
     knows (desktop/main/model-catalog.ts). All optional on purpose: a
     model added from Hugging Face is a `custom-…` id no catalogue
     describes, and it must render WITHOUT a blurb rather than with an
     invented one. ---- */
  name?: string;
  description?: string;
  /** Below this the model will not run on the host at all. */
  minRamGb?: number;
  /** At or above this it runs comfortably. */
  recommendedRamGb?: number;
  sizeGb?: number;
  /** The vision projector a pull fetches with the weights, in GB. */
  mmprojSizeGb?: number;
  vision?: boolean;
  tag?: string;
  uncensored?: boolean;
}

/**
 * `models list` prints a table, not JSON. Parsing it is the price of
 * showing the operator the real catalog with real disk state rather
 * than a list this app invented.
 *
 * The table carries no description and no RAM figures, so each row is
 * joined by id against the vendored catalogue metadata — see
 * `model-catalog.ts` for why that copy exists and how it is kept honest.
 */
export async function modelsList(): Promise<{ ok: boolean; models?: CatalogModel[]; error?: string }> {
  const res = await cli(["models", "list"], 45_000);
  if (!res.ok) return { ok: false, error: res.error };
  const models: CatalogModel[] = [];
  for (const line of res.stdout.split("\n")) {
    if (!line.includes("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 5 || cells[0] === "ID" || !cells[0]) continue;
    const id = cells[0]!;
    const meta = curatedMeta(id);
    models.push({
      id,
      family: cells[1] ?? "",
      size: cells[2] ?? "",
      context: cells[3] ?? "",
      downloaded: (cells[4] ?? "").toLowerCase() === "yes",
      active: (cells[5] ?? "").includes("*"),
      ...(meta
        ? {
            name: meta.name,
            description: meta.description,
            minRamGb: meta.minRamGb,
            recommendedRamGb: meta.recommendedRamGb,
            sizeGb: meta.sizeGb,
            ...(meta.mmprojSizeGb ? { mmprojSizeGb: meta.mmprojSizeGb } : {}),
            vision: meta.vision,
            ...(meta.tag ? { tag: meta.tag } : {}),
            ...(meta.uncensored ? { uncensored: true } : {}),
          }
        : {}),
    });
  }
  return models.length ? { ok: true, models } : { ok: false, error: "could not parse the model catalog" };
}

export function modelsUse(id: string): Promise<CliResult> {
  return withConfigLock(() => modelsUseNow(id));
}

/** `models use` and the url sync it needs, as one held-lock unit. */
async function modelsUseNow(id: string): Promise<CliResult> {
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
  const synced = await syncLocalLlamaProviderUrlInFileNow();
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
  const child = spawn(binary, ["models", "pull", id], { env: agentEnv(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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

/** The memory sizes Macs are sold with, in GB (really GiB). */
const MARKETED_RAM_GB = [4, 6, 8, 12, 16, 18, 24, 32, 36, 48, 64, 96, 128, 192, 256, 384, 512];

/**
 * Host RAM as the machine is sold: an "18 GB" Mac reports 19.3e9 bytes,
 * which is 18 GiB, and printing "19 GB" beside the box that says 18 read as
 * a mistake. Bytes → GiB, snapped to the nearest size Macs ship with when it
 * is within 0.75 GiB of one (a VM or an odd machine keeps its own rounded
 * figure). ONE helper for every surface — the wizard, Settings › Models and
 * the composer picker all read `app:hostRam`.
 */
export function marketedRamGb(bytes: number): number {
  const gib = bytes / 1024 ** 3;
  if (!(gib > 0)) return 1;
  let near = MARKETED_RAM_GB[0]!;
  for (const size of MARKETED_RAM_GB) if (Math.abs(size - gib) < Math.abs(near - gib)) near = size;
  return Math.abs(near - gib) <= 0.75 ? near : Math.max(1, Math.round(gib));
}

/** Whole gigabytes as the Mac is sold, the unit the catalog's RAM advice is written in. */
export function hostRamGb(): number {
  return marketedRamGb(totalmem());
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

/**
 * The `local-llama` entry the runtime implies but the file need not carry.
 *
 * A fresh state directory's config.json has NO `llm` key: the runtime
 * synthesizes the whole block at load time (`resolveLlmConfig`), so the
 * file stays silent about a route the operator never chose. The moment
 * anything writes an `llm` block — the wizard adding its first cloud
 * provider, for instance — the schema fills the missing
 * `activeTextProvider` with its default, `"local-llama"`, and validation
 * then rejects the file because no provider in it carries that id:
 *
 *   config set failed: invalid config: llm.activeTextProvider:
 *   unknown provider id "local-llama"
 *
 * which is what the first-run wizard hit. The TUI never sees it because
 * its own persist helper synthesizes this same entry whenever it writes
 * a block that was absent (src/tui/persist-llm-provider.ts).
 */
function localLlamaEntry(config: Record<string, unknown>): Record<string, unknown> {
  const local = (config.localModels ?? {}) as {
    url?: unknown;
    mode?: unknown;
    managed?: { port?: unknown };
    embeddings?: { url?: unknown };
  };
  const port = typeof local.managed?.port === "number" ? local.managed.port : 19091;
  const url =
    local.mode === "managed"
      ? `http://127.0.0.1:${port}`
      : typeof local.url === "string" && local.url
        ? local.url
        : `http://127.0.0.1:${port}`;
  const entry: Record<string, unknown> = { id: "local-llama", kind: "llama-server", url };
  if (typeof local.embeddings?.url === "string" && local.embeddings.url) {
    entry.baseUrl = local.embeddings.url;
  }
  return entry;
}

/**
 * Make an `llm` block name only providers it carries, before it is written.
 *
 * Deliberately narrow: it adds the `local-llama` entry the runtime would
 * have synthesized anyway, and nothing else. A block naming some OTHER
 * absent id is a real mistake by the caller and still fails loudly here
 * rather than being quietly repointed at whatever happens to be first —
 * repairing that would hide the bug instead of reporting it.
 */
export function normaliseLlmBlock(config: unknown): void {
  if (!config || typeof config !== "object") return;
  const root = config as Record<string, unknown>;
  const llm = root.llm as
    | { activeTextProvider?: unknown; activeEmbeddingProvider?: unknown; providers?: unknown }
    | undefined;
  if (!llm || typeof llm !== "object") return;
  if (!Array.isArray(llm.providers)) return;
  const providers = llm.providers as Array<{ id?: unknown }>;
  const has = (id: string): boolean => providers.some((p) => p && p.id === id);
  // An absent active id defaults to "local-llama" in the schema, so the
  // undefined case needs the entry exactly as much as the explicit one.
  const names = [llm.activeTextProvider, llm.activeEmbeddingProvider].map((v) =>
    typeof v === "string" && v ? v : "local-llama",
  );
  if (names.includes("local-llama") && !has("local-llama")) {
    providers.unshift(localLlamaEntry(root));
  }
}

/**
 * Every whole-file config write goes through here, which is why the
 * coherence repair lives here rather than in any one caller: there are a
 * dozen of them (provider upsert, custom models, fallback chain, MCP
 * servers, the external llama URL, the TUI import), and each one would
 * otherwise have to remember the rule.
 */
export function configSetWhole(config: unknown): Promise<CliResult> {
  return withConfigLock(() => writeWholeConfig(config));
}

/** The write itself, for the helpers below, which already hold the lock. */
async function writeWholeConfig(config: unknown): Promise<CliResult> {
  normaliseLlmBlock(config);
  const res = await cli(["config", "set", JSON.stringify(config)], 30_000);
  return res.ok ? res : { ...res, error: explainConfigWriteFailure(res.error) };
}

/**
 * The one config failure a person cannot act on as written.
 *
 * `config set failed: version 51 is newer than this build understands (49)`
 * is the agent refusing to write a settings file that a NEWER agent created:
 * writing it would silently drop whatever that newer schema added. Correct,
 * and unreadable — switching model showed two version numbers and no hint
 * of what to do.
 *
 * It surfaces because this app now ships its own agent and prefers it over
 * anything installed. Before that it used whatever `atag` was on the machine,
 * which was the same one that had written the file. A bundled agent older
 * than the state directory it inherits is a real state, and this says what it
 * means and what fixes it.
 */
export function explainConfigWriteFailure(error: string | undefined): string | undefined {
  if (!error) return error;
  const m = /version (\d+) is newer than this build understands \((\d+)\)/.exec(error);
  if (!m) return error;
  return (
    `This app's agent is older than your settings file — the file was written by `
    + `Atomic Agent with a newer settings format (${m[1]}; this build reads ${m[2]}), `
    + `and writing it now would quietly drop whatever that version added. `
    + `Update the app to a build whose agent is at least as new, or start it on a `
    + `fresh settings directory.`
  );
}

/* ---------------------------------------------------------------
   Backlog 32 — an API key is plain ASCII, and nothing else gets in.

   A key travels in an HTTP header, and a header value cannot carry a
   character outside that range. The agent refuses such a key on every
   request, before anything is sent (`assertAsciiApiKey`,
   src/llm/provider/openai/ascii-header-guard.ts), and its TUI refuses it on
   the key screen (`apiKeyPhaseError`, src/tui/providers/providers-wizard-target.ts).
   The desktop did neither. A key with a letter typed in another keyboard
   layout, or with a zero-width space a copy brought along (trim() takes the
   no-break space at either end, not that), was saved as it was; the key
   check below turned fetch's own refusal of the header into "Could not reach
   api.aimlapi.com — the key was not checked" and offered Save unchecked; and
   every turn on that provider then fell over to the next one in the chain
   and parked on its `fetch failed` — "no connection", for a request that
   never left the machine.

   So the key fields clean what they are given (renderer.js does the same on
   paste and on save), main refuses to save what is still not a key, the
   check refuses it in its own words, and a key already saved that way is not
   counted as a key at all: Settings › Models and the composer say it needs
   pasting again.
   --------------------------------------------------------------- */

/** Invisible format characters a copy carries along and no key has: soft hyphen, zero-width space/joiners, direction marks, word joiner, BOM. */
const INVISIBLE_IN_KEY = /[\u00ad\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/** What a key field keeps of what it was given: no invisible characters anywhere, no whitespace (the no-break space included) at either end. */
export function cleanApiKey(raw: string): string {
  return raw.replace(INVISIBLE_IN_KEY, "").trim();
}

/** The agent's own rule for a key (`isAsciiOnly` in ascii-header-guard.ts). */
export function apiKeyCharsOk(key: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7f]*$/.test(key);
}

/** Said wherever a key that still has such a character is refused. */
export const API_KEY_CHAR_ERROR = "That key has a character keys don’t have; paste it again.";

/** Add a provider, or replace the entry that already carries its id. */
export function upsertProvider(entry: ProviderEntry): Promise<CliResult> {
  return withConfigLock(() => upsertProviderNow(entry));
}

async function upsertProviderNow(entry: ProviderEntry): Promise<CliResult> {
  if (!/^[\w.-]{1,48}$/.test(entry.id)) {
    return { ok: false, stdout: "", stderr: "", error: `not a provider id: ${entry.id}` };
  }
  // Backlog 32: every window path that saves a key comes through here.
  if (typeof entry.apiKey === "string" && entry.apiKey.length > 0) {
    const key = cleanApiKey(entry.apiKey);
    if (!apiKeyCharsOk(key)) return { ok: false, stdout: "", stderr: "", error: API_KEY_CHAR_ERROR };
    entry = { ...entry, apiKey: key };
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
  return writeWholeConfig(config);
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
export function addCustomModelEntry(def: Record<string, unknown>): Promise<CliResult> {
  return withConfigLock(() => addCustomModelEntryNow(def));
}

async function addCustomModelEntryNow(
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
  return writeWholeConfig(config);
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

/**
 * The chat daemon's speed as `models start` measures it once the daemon is
 * healthy (agent ≥0.6.3, src/cli/models-handlers.ts): "chat: started pid N,
 * healthy on port P[, vision …], ~N tok/s single stream". Null when the line
 * has no measurement (older agent, or the probe did not answer).
 */
export function parseChatStartSpeed(stdout: string): { pid: number; tokensPerSecond: number } | null {
  const m = /chat: started pid (\d+), healthy on port \d+.*?, ~(\d+(?:\.\d+)?) tok\/s single stream/.exec(stdout);
  return m ? { pid: Number(m[1]), tokensPerSecond: Number(m[2]) } : null;
}

/* The last measurement, keyed by the daemon pid it was taken on: a daemon
   restarted by anything else (the TUI, a crash) never inherits it. Every
   start the desktop makes — launch, backend switch, Settings — goes through
   modelsStart, so this is the one place to catch it. */
let lastChatSpeed: { pid: number; tokensPerSecond: number } | null = null;

/* Every `models start` on its way, so quitting can end them all (item 30): one
   that outlives the app brings a model server up after the app's stop ran. */
const startsOnTheirWay = new Set<{ abort: AbortController; done: Promise<unknown> }>();

/* Backlog 18 (its second review): set once quitting has begun (closeStarts).
   Killing the starts on their way (abortStarts) was not enough. A start whose
   daemon turn began before the quit can still be in that turn's `models status`
   or `models stop` — item 31's reaping alone takes 2 s or more — and its
   `models start` came after every start on its way had been killed: the
   llama-server came up after the app was gone. */
let startsClosed = false;

/** Quitting (backend-switch closeDaemonTurns): no `models start` spawns from here on. The undo is for a smoke check, which carries on after it. */
export function closeStarts(): () => void {
  startsClosed = true;
  return () => { startsClosed = false; };
}

/** What a start that spawned nothing says: the app is quitting. */
export const START_REFUSED_QUITTING = "the app is quitting — the model server was not started";
/** What a start that spawned nothing says: a stop or a switch came after it was asked for. */
export const START_REFUSED_MOVED_ON = "a stop or a switch came first — the model server was not started";

/**
 * Start the managed llama daemon after switching to a local model. `signal`
 * kills the start (item 11: a stop that supersedes it).
 *
 * Item 31: a start whose server has answered healthy and then closed its port
 * is ended at once. `models start` probes a fresh server's speed with one
 * request and waits for its answer; a server killed by hand during that probe
 * closes its port and never answers, so the start sat out its whole 90 s, and
 * with it the daemon's turn — every Start, launch start, model pick and swap
 * queued behind it said nothing for a minute and a half.
 *
 * Backlog 18 (its second review): once the quit has begun (closeStarts), or
 * when `stillWanted` says a stop or a switch came after the start was asked
 * for, it spawns nothing and answers `notStarted`. Both are asked here, at the
 * spawn itself — nothing from this line to `cli` spawning `models start`
 * awaits — and not only as the start's daemon turn began: that turn's own
 * `models status` or `models stop` takes seconds.
 */
export async function modelsStart(
  opts: { signal?: AbortSignal; stillWanted?: () => boolean } = {},
): Promise<CliResult & { notStarted?: boolean }> {
  if (startsClosed) return { ok: false, stdout: "", stderr: "", error: START_REFUSED_QUITTING, notStarted: true };
  if (opts.stillWanted && !opts.stillWanted()) {
    return { ok: false, stdout: "", stderr: "", error: START_REFUSED_MOVED_ON, notStarted: true };
  }
  const abort = new AbortController();
  const forward = () => abort.abort();
  if (opts.signal?.aborted) abort.abort();
  else opts.signal?.addEventListener("abort", forward, { once: true });
  const port = managedPortFromFile();
  let gone = false;
  const watch = port === null ? null : watchStartedServer(port, () => { gone = true; abort.abort(); });
  const run = cli(["models", "start"], 90_000, undefined, abort.signal);
  const entry = { abort, done: run };
  startsOnTheirWay.add(entry);
  try {
    const res = await run;
    if (gone) {
      return { ...res, ok: false, error: "the model server stopped answering while it was starting — it was not started; start it again" };
    }
    if (res.ok) {
      const speed = parseChatStartSpeed(res.stdout);
      if (speed) lastChatSpeed = speed;
    }
    return res;
  } finally {
    watch?.stop();
    opts.signal?.removeEventListener("abort", forward);
    startsOnTheirWay.delete(entry);
  }
}

/**
 * Item 30: kill every `models start` on its way, and wait (up to `ms`) for
 * them to be gone, so what one already spawned is in its pid file for the
 * `models stop` that follows.
 */
export async function abortStarts(ms: number): Promise<number> {
  const starts = [...startsOnTheirWay];
  for (const s of starts) s.abort.abort();
  if (starts.length) await Promise.race([Promise.allSettled(starts.map((s) => s.done)), new Promise((r) => setTimeout(r, ms))]);
  return starts.length;
}

/** Item 31: how long a started server's port may refuse connections before its start is ended. */
const START_GONE_MS = 2_000;

/**
 * Watch the managed port through a start: once the server has answered
 * healthy (200), a port that then refuses connections for START_GONE_MS means
 * it is going away, and `gone` is called once. A server that never gets that
 * far (it is still loading, or a GPU build that fails and falls back) is
 * never judged here — `models start` reports those itself.
 */
function watchStartedServer(port: number, gone: () => void): { stop: () => void } {
  let healthy = false;
  let refusedSince: number | null = null;
  let looking = false;
  let fired = false;
  const timer = setInterval(() => {
    if (looking || fired) return;
    looking = true;
    void portAnswer(port).then((a) => {
      looking = false;
      if (fired) return;   // stopped meanwhile: the start is over
      if (a.kind === "answer") {
        if (a.status === 200) healthy = true;
        refusedSince = null;
        return;
      }
      if (a.kind !== "refused" || !healthy) return;
      refusedSince ??= Date.now();
      if (Date.now() - refusedSince >= START_GONE_MS) {
        fired = true;
        gone();
      }
    });
  }, 500);
  timer.unref?.();
  return { stop: () => { fired = true; clearInterval(timer); } };
}

/**
 * `localModels.managed.port` as the CLI reads it, straight from
 * `<stateDir>/config.json` (no `config get` per start); 19091, the agent's
 * default, when the file names none; null when the file cannot be read.
 */
function managedPortFromFile(): number | null {
  try {
    const cfg = JSON.parse(readFileSync(join(DESKTOP_STATE_DIR, "config.json"), "utf8")) as {
      localModels?: { managed?: { port?: unknown } };
    };
    const port = cfg.localModels?.managed?.port;
    return typeof port === "number" && Number.isInteger(port) && port > 0 ? port : 19091;
  } catch {
    return null;
  }
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
   Verifying that a cloud key actually works.

   The add-provider wizard used to call the `providerModels` lookup above
   a "verification", and said so on screen: "checking the key against the
   provider's model list". It is not one. `models search` answers
   `openrouter` and `aimlapi` from a catalogue BUNDLED IN THE BINARY and
   never leaves the machine, and even `--refresh` fetches a PUBLIC list
   that needs no credentials: a 64-zero string passes, the wizard says
   "Cloud model ready", the setup closes, and the operator finds out at
   the first message. A check that cannot fail is worse than no check,
   because it converts "I typed my key wrong" into "the cloud providers
   are broken".

   So ask the provider something only a valid key can answer: the
   one-token chat completion the app is about to make for real. It costs
   a token, it is the same URL, key and model the turn will use, and it
   catches the whole family at once — wrong key, revoked key, no credit,
   a model this key cannot reach, an unreachable custom base URL.

   `checked: false` is the honest third answer. If this build has no
   endpoint for the kind, or the network is down, say the key was SAVED
   but NOT verified rather than claiming either verdict.
   --------------------------------------------------------------- */

/** Where a kind's OpenAI-compatible chat endpoint lives. */
function chatCompletionsUrl(kind: string, baseUrl?: string): string | null {
  // The agent's own normalizeOpenAiBaseUrl rule: strip a trailing `/v1`
  // so the path is never doubled.
  const root = (u: string) => u.replace(/\/+$/, "").replace(/\/v1$/, "");
  if (kind === "openrouter") return `${root(baseUrl || "https://openrouter.ai/api")}/v1/chat/completions`;
  if (kind === "aimlapi") return `${root(baseUrl || "https://api.aimlapi.com")}/v1/chat/completions`;
  // Google's OpenAI-compatible shim, the surface the agent's gemini provider uses.
  if (kind === "gemini") return "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
  if (kind === "openai-compatible" || kind === "qwen-openai-compatible") {
    return baseUrl ? `${root(baseUrl)}${chatPathPrefix(root(baseUrl))}/chat/completions` : null;
  }
  return null;
}

/* The agent's openAiChatPathPrefix rule (src/llm/provider/openai/openai-chat-path.ts),
   so the key is checked on the URL the turns will use. Perplexity serves chat
   at the bare root of api.perplexity.ai and answers 404 under /v1; its Router
   API (`/router`) and every other root keep `/v1`. */
function chatPathPrefix(root: string): string {
  try {
    const url = new URL(root);
    const bare = url.pathname === "" || url.pathname === "/";
    return bare && url.hostname.toLowerCase() === "api.perplexity.ai" ? "" : "/v1";
  } catch {
    return "/v1";
  }
}

/**
 * The VALUE of the key the agent would use, by the agent's own
 * precedence: an explicit `apiKey` on the entry, else the environment,
 * else <stateDir>/.env (which load-dotenv.ts applies only where the
 * environment is silent). Never logged, never returned to the renderer —
 * it leaves this function only inside an Authorization header.
 */
function resolveKeyValue(entry: ProviderEntry): string | null {
  if (entry.apiKey && entry.apiKey.length > 0) return entry.apiKey;
  const names: string[] = [];
  if (entry.apiKeyEnvVar) names.push(entry.apiKeyEnvVar);
  if (entry.kind === "openrouter") names.push("OPENROUTER_API_KEY");
  if (entry.kind === "aimlapi") names.push("AIMLAPI_API_KEY");
  if (entry.kind === "gemini") names.push("GEMINI_API_KEY");
  if (entry.kind === "openai-compatible" || entry.kind === "qwen-openai-compatible") {
    names.push("OPENAI_COMPAT_API_KEY", "OPENAI_API_KEY", "ATOMIC_AGENT_OPENAI_API_KEY");
  }
  for (const name of names) {
    const v = process.env[name];
    if (v !== undefined) return v.length > 0 ? v : null; // set-but-empty wins, as for the agent
  }
  let text: string;
  try {
    text = readFileSync(join(stateDirPath(), ".env"), "utf8");
  } catch {
    return null;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m || !names.includes(m[1]!)) continue;
    const v = m[2]!.trim().replace(/^["']|["']$/g, "");
    return v.length > 0 ? v : null;
  }
  return null;
}

export interface ProviderVerification {
  /** The provider answered as this key's owner, for this model. */
  ok: boolean;
  /** False when nothing could be asked — no endpoint for the kind, or the network failed. */
  checked: boolean;
  status?: number;
  error?: string;
  /** Backlog 32: the key has a character keys don't have, so it was refused here, unsent. */
  keyChars?: boolean;
}

/** Ask the provider to complete one token, and report what it said. */
export async function verifyProviderKey(
  entry: ProviderEntry,
  model: string,
  timeoutMs = 30_000,
): Promise<ProviderVerification> {
  const url = chatCompletionsUrl(entry.kind, entry.baseUrl);
  if (!url) return { ok: false, checked: false, error: `this build cannot check a ${entry.kind || "provider"} key` };
  if (!model) return { ok: false, checked: false, error: "no model to check the key against" };
  const key = resolveKeyValue(entry);
  /* Backlog 32: such a key cannot go into the header. fetch refuses it before
     it opens a connection (a TypeError for a character above U+00FF), and the
     catch below used to read that as an unreachable host — "the key was not
     checked", with Save unchecked on offer. A no-break space inside the key
     would go out as it is and come back a 401. It is a verdict on the key,
     reached here, and nothing is sent. */
  if (key && !apiKeyCharsOk(key)) {
    return { ok: false, checked: true, keyChars: true, error: API_KEY_CHAR_ERROR };
  }
  // A keyless local server is asked the same one-token question, just without Authorization.
  if (!key && !isKeylessLocalProviderEntry(entry)) {
    return {
      ok: false,
      checked: true,
      error: entry.apiKeyEnvVar
        ? `no API key — type one above, or set ${entry.apiKeyEnvVar}`
        : "no API key — type one above",
    };
  }
  const headers: Record<string, string> = { "content-type": "application/json", ...(entry.headers ?? {}) };
  if (key && entry.apiKeyHeader) headers[entry.apiKeyHeader] = key;
  else if (key) headers.authorization = `Bearer ${key}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      // 16, not 1: AI/ML API answers `max_tokens: 1` on a reasoning model
      // with HTTP 400 "model output limit was reached", which would have
      // failed a perfectly good key.
      body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 16, stream: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Unreachable is not "your key is wrong": do not pretend to a verdict.
    /* "fetch failed" is undici's words, not a sentence for a person.
       What the user needs is which host did not answer and what that means
       for their key; the underlying message adds nothing they can act on. */
    return { ok: false, checked: false, error: `Could not reach ${new URL(url).host} — the key was not checked.` };
  }
  if (res.ok) return { ok: true, checked: true, status: res.status };
  // 429 means the service knew who we were and throttled us. That is an
  // ACCEPTED key: an unknown one gets 401 long before a rate limit.
  if (res.status === 429) return { ok: true, checked: true, status: res.status };
  // The provider's own sentence is the useful one — "User not found",
  // "Insufficient credits", "model not available" — so pass it through
  // rather than replacing it with a status code.
  let detail = "";
  try {
    const text = (await res.text()).slice(0, 2000);
    const parsed: unknown = JSON.parse(text);
    // Google's OpenAI-compatible surface wraps the error object in an
    // array, `[{"error": {...}}]`; read as an object it had no message and
    // the person got the raw JSON instead of "Please pass a valid API key".
    const body = (Array.isArray(parsed) ? parsed[0] : parsed) as
      | { error?: { message?: string } | string; message?: string }
      | null
      | undefined;
    const e = body?.error;
    detail = (typeof e === "string" ? e : e?.message) || body?.message || text;
  } catch {
    detail = "";
  }
  const say = (why: string) => (detail ? `${why}: ${detail.slice(0, 300)}` : why);
  if (res.status === 401 || res.status === 403) {
    return { ok: false, checked: true, status: res.status, error: say("the provider rejected this key") };
  }
  if (res.status === 402) {
    return { ok: false, checked: true, status: res.status, error: say("the key works but the account cannot pay for a request") };
  }
  /* Everything else — a 400 about the request shape, a 404 about the
     model, a 5xx — says nothing about the key, and guessing would be the
     same sin in the other direction: a wrong NO is worse than the old
     wrong YES, because it locks the operator out of a provider that
     works. Report it as unchecked, with the provider's own words. */
  return { ok: false, checked: false, status: res.status, error: say(`the provider answered HTTP ${res.status}`) };
}

/** Drop a provider entry by id — the rollback for a key that did not verify. */
export function removeProvider(id: string): Promise<CliResult> {
  return withConfigLock(() => removeProviderNow(id));
}

async function removeProviderNow(id: string): Promise<CliResult> {
  if (!/^[\w.-]{1,48}$/.test(id)) return { ok: false, stdout: "", stderr: "", error: `not a provider id: ${id}` };
  const current = await configGet();
  if (!current.ok || !current.config) {
    return { ok: false, stdout: "", stderr: "", error: current.error ?? "could not read the config" };
  }
  const config = current.config as { llm?: { providers?: ProviderEntry[] } };
  const providers = config.llm?.providers;
  if (!providers) return { ok: true, stdout: "", stderr: "" };
  const kept = providers.filter((p) => p.id !== id);
  if (kept.length === providers.length) return { ok: true, stdout: "", stderr: "" };
  config.llm!.providers = kept;
  return writeWholeConfig(config);
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
    managed?: { modelId?: string | null; port?: number; parallel?: number | string };
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
    /* The TUI's run mode. Additive: `activeTextProvider` stays authoritative,
       and `fusion` is the one mode that needs both legs — a cloud model
       orchestrating several llama-server workers. */
    runMode?: {
      mode?: "local" | "cloud" | "fusion";
      fusion?: {
        orchestratorProvider?: string;
        orchestratorModel?: string;
        workerProvider?: string;
        workerModel?: string;
        workers?: number;
        workerMaxSteps?: number;
        workerTimeoutMs?: number;
      };
    };
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

/**
 * U29: remove provider entries the agent cannot build (an OpenAI-compatible
 * entry with no chat model, left by an add-provider wizard that was never
 * finished) before `atag serve` reads the file. See provider-hygiene.ts for
 * which entries qualify and why referenced ones are kept.
 */
export function pruneIncompleteProvidersInFile(): Promise<WriteResult & { removed: string[] }> {
  return withConfigLock(async () => {
    const read = await readWholeConfig();
    if (!read.ok || !read.config) return { ok: false, changed: false, removed: [], error: read.error };
    const removed = pruneIncompleteProviders(read.config);
    if (!removed.length) return { ok: true, changed: false, removed };
    const w = await writeWholeConfig(read.config);
    return w.ok ? { ok: true, changed: true, removed } : { ok: false, changed: false, removed: [], error: w.error };
  });
}

async function syncLocalLlamaProviderUrlInFileNow(): Promise<WriteResult> {
  const read = await readWholeConfig();
  if (!read.ok || !read.config) return { ok: false, changed: false, error: read.error };
  if (!syncLocalLlamaProviderUrl(read.config)) return { ok: true, changed: false };
  const w = await writeWholeConfig(read.config);
  return w.ok ? { ok: true, changed: true } : { ok: false, changed: false, error: w.error };
}

/**
 * setActiveTextProviderInConfig: synthesizes the llm block exactly as
 * the TUI does when it is absent (url only — no baseUrl), refuses an id
 * that names no provider, writes ONLY llm.activeTextProvider.
 */
export function setActiveTextProvider(id: string, opts: { leaveFusion?: boolean } = {}): Promise<WriteResult> {
  return withConfigLock(() => setActiveTextProviderNow(id, opts));
}

/**
 * `leaveFusion`: the TUI's activateCloud / activateLocal. A plain route
 * switch writes `llm.activeTextProvider` alone, and `resolveRunMode` keeps
 * honouring a stored `runMode.mode: "fusion"` for as long as the active
 * provider is the orchestrator — which is exactly the provider "cloud"
 * picks. So a switch that means to leave Fusion writes the stored mode in
 * the same write (`RunModeOrchestrator.setMode`), or the window lands in
 * effective Fusion while its chip says cloud.
 */
async function setActiveTextProviderNow(id: string, opts: { leaveFusion?: boolean } = {}): Promise<WriteResult> {
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
  const run = llm.runMode;
  const leaving = opts.leaveFusion === true && run?.mode === "fusion";
  if (llm.activeTextProvider === id && !synthesized && !leaving) return { ok: true, changed: false };
  llm.activeTextProvider = id;
  if (leaving && run) {
    run.mode = providers.find((p) => p.id === id)?.kind === "llama-server" ? "local" : "cloud";
  }
  const w = await writeWholeConfig(cfg);
  return w.ok ? { ok: true, changed: true } : { ok: false, changed: false, error: w.error };
}

/** LocalModelsOrchestrator.useManagedMode: persistUserLocalModelsConfig({mode:"managed"}) + url sync. */
export function useManagedMode(): Promise<WriteResult> {
  return withConfigLock(useManagedModeNow);
}

async function useManagedModeNow(): Promise<WriteResult> {
  const read = await readWholeConfig();
  if (!read.ok || !read.config) return { ok: false, changed: false, error: read.error };
  const cfg = read.config;
  const lm = (cfg.localModels ??= {});
  if (lm.mode === "managed") return { ok: true, changed: false };
  lm.mode = "managed";
  syncLocalLlamaProviderUrl(cfg);
  const w = await writeWholeConfig(cfg);
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
export function setExternalLlamaUrl(url: string): Promise<WriteResult> {
  return withConfigLock(() => setExternalLlamaUrlNow(url));
}

async function setExternalLlamaUrlNow(url: string): Promise<WriteResult> {
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
  const w = await writeWholeConfig(cfg);
  return w.ok ? { ok: true, changed: true } : { ok: false, changed: false, error: w.error };
}

/** persistMemoryEmbeddingsEnabled: a no-op when the flag already matches. */
export function setMemoryEmbeddingsEnabled(enabled: boolean): Promise<WriteResult> {
  return withConfigLock(() => setMemoryEmbeddingsEnabledNow(enabled));
}

async function setMemoryEmbeddingsEnabledNow(enabled: boolean): Promise<WriteResult> {
  const read = await readWholeConfig();
  if (!read.ok || !read.config) return { ok: false, changed: false, error: read.error };
  const cfg = read.config;
  const mem = (cfg.memory ??= {});
  const emb = (mem.embeddings ??= {});
  if (emb.enabled === enabled) return { ok: true, changed: false };
  emb.enabled = enabled;
  const w = await writeWholeConfig(cfg);
  return w.ok ? { ok: true, changed: true } : { ok: false, changed: false, error: w.error };
}

/**
 * `atag models status` prints `daemon:         running (pid N)  <url>` or
 * `stopped` in managed mode, and only `mode: external` + `url:` in
 * external mode (src/cli/models-handlers.ts runLocalModelsStatus).
 *
 * Item 31: "running" is judged by the port, not by the pid alone. A
 * llama-server that gets SIGTERM while a request is open on it (killed by
 * hand mid-turn, or during `models start`'s speed probe) closes its port and
 * then waits for that request for good: its pid stays alive and `models
 * status` keeps printing `running (pid N)`. Every start took that for a
 * daemon that was up — Settings' Start said "already running", the launch
 * start and a model pick started nothing — and only a cloud switch, which
 * stops first, brought the model back. So a pid that is alive while its port
 * refuses connections, through a short grace (a server spawned a moment ago
 * binds within a second; a loading one answers 503), is stopped through
 * `models stop` (SIGTERM, then SIGKILL after 3 s) and counted down, and the
 * start that asked brings a fresh one up. `reapWedged: false` is for a stop
 * decision (the cloud switch), where anything still there is stopped anyway.
 */
export async function localDaemonRunning(opts: { reapWedged?: boolean } = {}): Promise<boolean> {
  const res = await cli(["models", "status"], 20_000);
  // An agent that printed the whole status and then failed on an extra still told us the status (modelsStatus).
  if (!res.ok && !/^mode:/m.test(res.stdout)) return false;
  /* `daemon:` is read from a pid file; `health:` is read from the port, and
     the two disagree. `atag models start` against a daemon that is ALREADY
     up spawns a duplicate that cannot bind, dies, and records its pid —
     after which getDaemonStatus finds that pid dead, unlinks the pid file
     and reports `stopped` while printing `health: ok` in the same block,
     for a daemon that is serving requests (reproduced: the listener kept
     one pid while three starts in a row each reported a different, already
     dead one). That is an agent-side defect, not the desktop's, and it is
     not this fixture's to assert. What the switch owes the user is a local
     route that ANSWERS, so the port is the authority here. */
  if (/^health:\s+ok/m.test(res.stdout)) return true;
  const daemon = /^daemon:[ \t]+running \(pid (\d+)\)[ \t]*(\S*)/m.exec(res.stdout);
  if (!daemon) return false;
  if (opts.reapWedged === false) return true;
  // `health:` is not `ok` while a model loads either (the agent reads llama-server's 503 as `down`), so the port itself is asked.
  const port = portOfUrl(daemon[2] ?? "");
  if (port === null || !(await refusesThroughout(port, WEDGED_GRACE_MS))) return true;
  const stop = await modelsStop();
  console.error(
    `[desktop] the model server (pid ${daemon[1]}) was alive with its port closed — `
      + (stop.ok ? "stopped it" : `could not stop it: ${stop.error ?? "unknown error"}`),
  );
  return false;
}

/** Item 31: how long a live daemon's port may refuse connections before the daemon counts as down. */
const WEDGED_GRACE_MS = 2_000;

/** The port of `http://127.0.0.1:N`, or null. */
function portOfUrl(url: string): number | null {
  const m = /^https?:\/\/[^/\s:]+:(\d+)/.exec(url);
  return m ? Number(m[1]) : null;
}

/**
 * One look at a local port: `answer` is any HTTP status (llama-server says 503
 * while a model loads), `refused` is nothing listening, `silent` is no answer in
 * time (a busy or frozen listener — never read as gone). 2.5 s: Windows takes
 * about two seconds to refuse a connection to a closed local port.
 */
export async function portAnswer(port: number, timeoutMs = 2_500): Promise<{ kind: "answer"; status: number } | { kind: "refused" | "silent" }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    void res.body?.cancel().catch(() => undefined);
    return { kind: "answer", status: res.status };
  } catch (err) {
    const code = (err as { cause?: { code?: unknown } }).cause?.code;
    return { kind: code === "ECONNREFUSED" ? "refused" : "silent" };
  }
}

/**
 * Whether `port` stays shut for `ms`: no look answers, and the last one is
 * refused. A look that gets no answer in time (or meets a pooled connection the
 * server has just closed) proves nothing either way, so it only keeps looking.
 */
async function refusesThroughout(port: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    const look = await portAnswer(port);
    if (look.kind === "answer") return false;
    if (Date.now() >= until) return look.kind === "refused";
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** LocalModelsOrchestrator.stopDaemon's process half: stops chat + embedding daemons. */
export async function modelsStop(): Promise<CliResult> {
  return cli(["models", "stop"], 30_000);
}

/** The pids the daemons' pid files name (`llama-server.pid`, `llama-embed.pid`, src/local-llm/backend-paths.ts). */
export function daemonPidsIn(dataDir: string): number[] {
  const pids: number[] = [];
  for (const file of ["llama-server.pid", "llama-embed.pid"]) {
    try {
      const pid = Number(readFileSync(join(dataDir, file), "utf8").trim());
      if (Number.isInteger(pid) && pid > 1) pids.push(pid);
    } catch {
      // no such daemon
    }
  }
  return pids;
}

/**
 * Item 30: SIGKILL, from this process, each of `pids` that is still alive and
 * still a llama-server (a pid reused by anything else is never touched).
 * Answers the pids it killed.
 */
export function killDaemonLeftovers(pids: number[]): number[] {
  const killed: number[] = [];
  for (const pid of new Set(pids)) {
    try {
      process.kill(pid, 0);
    } catch {
      continue;   // gone already
    }
    const command = commandOf(pid);
    if (!command || !/llama-server/i.test(command)) continue;
    try {
      process.kill(pid, "SIGKILL");
      killed.push(pid);
    } catch {
      // went in between
    }
  }
  return killed;
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
  /** Backlog 32: non-empty, with a character no key has — the agent refuses to send it. */
  badChars: Set<string>;
}

// r5 review fix — exported for tui-import.ts, which has to answer
// "will this provider have a key HERE?" for names the import is about to
// write into the desktop's own .env, not just the ones already resolvable.
export function keyNamesAvailable(): KeyEnvNames {
  const present = new Set<string>();
  const nonEmpty = new Set<string>();
  const badChars = new Set<string>();
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    present.add(k);
    if (v.length > 0) nonEmpty.add(k);
    if (v.length > 0 && !apiKeyCharsOk(v)) badChars.add(k);
  }
  try {
    const text = readFileSync(join(stateDirPath(), ".env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
      if (!m) continue;
      const name = m[1]!;
      if (present.has(name)) continue; // the environment wins, as in load-dotenv.ts
      present.add(name);
      const value = m[2]!.trim().replace(/^["']|["']$/g, "");
      if (value.length > 0) nonEmpty.add(name);
      if (value.length > 0 && !apiKeyCharsOk(value)) badChars.add(name);
    }
  } catch {
    // no .env — the environment alone decides
  }
  return { present, nonEmpty, badChars };
}

/**
 * resolveLlmProviderApiKey, answered as a boolean; subscription-CLI kinds
 * authenticate elsewhere. The openai-compatible chain is the agent's
 * `A ?? B ?? C` then `length > 0`: the first variable that is SET decides,
 * so `OPENAI_COMPAT_API_KEY=""` next to a real `OPENAI_API_KEY` is "no key"
 * here exactly as it is for the agent.
 */
/** Preset ids with `local: true` in src/tui/providers/provider-presets.ts. */
const LOCAL_PRESET_IDS = new Set(["atomic-chat", "lmstudio", "ollama"]);

/**
 * src/tui/local-backend-readiness.ts isKeylessLocalProviderEntry: a server
 * on this machine (Atomic Chat, Ollama, LM Studio, a hand-added loopback
 * endpoint) has no API key at all, so a missing key must not block it —
 * the agent saves it with no key and sends requests without Authorization.
 */
export function isKeylessLocalProviderEntry(entry: ProviderEntry): boolean {
  if (entry.kind !== "openai-compatible") return false;
  if (LOCAL_PRESET_IDS.has(entry.id)) return true;
  return isLocalProviderUrl(entry.baseUrl ?? "");
}

/** Ready to route to: a key, or a keyless local server (isCloudTextProviderReady) — and never a key the agent will refuse to send (backlog 32). */
export function providerIsUsable(entry: ProviderEntry, names: KeyEnvNames = keyNamesAvailable()): boolean {
  if (providerKeyInvalid(entry, names)) return false;
  return providerHasKey(entry, names) || isKeylessLocalProviderEntry(entry);
}

/**
 * Backlog 32: the key the agent would send for this entry has a character no
 * key has, so every request is refused before it leaves the machine. Same
 * precedence as `providerHasKey` (the agent's resolveLlmProviderApiKey): the
 * entry's own key, else the variable it reads. The value is tested where it
 * lies and never leaves main.
 */
export function providerKeyInvalid(entry: ProviderEntry, names: KeyEnvNames = keyNamesAvailable()): boolean {
  if (entry.apiKey && entry.apiKey.length > 0) return !apiKeyCharsOk(entry.apiKey);
  if (entry.kind === "subscription-cli") return false;
  let name: string | undefined;
  if (entry.apiKeyEnvVar && entry.apiKeyEnvVar.length > 0) name = entry.apiKeyEnvVar;
  else if (entry.kind === "openrouter") name = "OPENROUTER_API_KEY";
  else if (entry.kind === "aimlapi") name = "AIMLAPI_API_KEY";
  else if (entry.kind === "gemini") name = "GEMINI_API_KEY";
  else if (entry.kind === "openai-compatible" || entry.kind === "qwen-openai-compatible") {
    name = ["OPENAI_COMPAT_API_KEY", "OPENAI_API_KEY", "ATOMIC_AGENT_OPENAI_API_KEY"].find((n) => names.present.has(n));
  }
  return !!name && names.badChars.has(name);
}

/** What a switch says when the saved key is one the agent will not send. */
export const STORED_KEY_INVALID = "its saved API key has a character keys don’t have; paste it again";

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

/**
 * Read, plan and write the whole file under ONE hold of the config lock.
 *
 * The run-mode writes (main/run-mode.ts) decide what to write from what the
 * file says — which leg is active, which provider is pinned — so reading it
 * outside the lock and writing it inside would let a write that landed in
 * between be silently undone. `plan` mutates the object it is handed and
 * says whether it did; nothing is written when it did not.
 */
export function rewriteWholeConfig<V extends { write: boolean }>(
  plan: (cfg: UserConfigShape) => V,
): Promise<{ ok: boolean; changed: boolean; error?: string; verdict?: V }> {
  return withConfigLock(async () => {
    const read = await readWholeConfig();
    if (!read.ok || !read.config) return { ok: false, changed: false, error: read.error };
    const verdict = plan(read.config);
    if (!verdict.write) return { ok: true, changed: false, verdict };
    const w = await writeWholeConfig(read.config);
    return w.ok ? { ok: true, changed: true, verdict } : { ok: false, changed: false, error: w.error, verdict };
  });
}

/**
 * Ids of the configured cloud providers that have a usable key, for the
 * selector's row copy — and (backlog 32) of those whose saved key is one the
 * agent will not send, so the window can say so rather than "no API key".
 */
export async function providersReady(): Promise<{ ok: boolean; ids?: string[]; invalidKeyIds?: string[]; error?: string }> {
  const read = await readWholeConfig();
  if (!read.ok || !read.config) return { ok: false, error: read.error };
  const names = keyNamesAvailable();
  const cloud = (read.config.llm?.providers ?? []).filter((p) => p.kind !== "llama-server");
  const ids = cloud.filter((p) => providerIsUsable(p, names)).map((p) => p.id);
  const invalidKeyIds = cloud.filter((p) => providerKeyInvalid(p, names)).map((p) => p.id);
  return { ok: true, ids, invalidKeyIds };
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
  return withConfigLock(() => cli(["config", "unset", key]));
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
    // A description is free text out of the skill's own SKILL.md, so it can
    // carry a newline and arrive here as its own line. That is a continuation
    // of the row above, not a malformed row: fold it back into the
    // description rather than failing the whole tab. Only a leading line that
    // is not a row at all is an error — and even then only when nothing has
    // parsed yet, so one odd line can never blank a list that did read.
    if (cells.length < 4) {
      const prev = rows[rows.length - 1];
      if (prev) {
        prev.description = `${prev.description} ${line.trim()}`.trim();
        continue;
      }
      return { ok: false, error: `could not parse skill list line: ${line.slice(0, 120)}` };
    }
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
export function configSetPath(key: string, value: unknown): Promise<CliResult> {
  return withConfigLock(() => configSetPathNow(key, value));
}

async function configSetPathNow(key: string, value: unknown): Promise<CliResult> {
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
  return writeWholeConfig(tree);
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
  /** `~N tok/s` from the `models start` that brought up THIS daemon pid; null when unmeasured. */
  tokensPerSecond: number | null;
  /**
   * `fault:` (agent 0.6.6, describeServerFault): what the running server's
   * own log says is wrong while `health:` still reads ok, e.g. the GPU
   * running out of memory on every request. Null when the line is absent.
   */
  fault: string | null;
}

/**
 * `atag models status` — `mode:`, `data dir:`, `backend:`, `compute:`,
 * `active model:`, `daemon:`, `health:` (and `fault:` when the log shows one) in managed mode; `mode: external`
 * + `url:` otherwise (src/cli/models-handlers.ts). Parsed by label, never
 * by column.
 */
export async function modelsStatus(): Promise<{ ok: boolean; status?: ModelsStatus; error?: string }> {
  const res = await cli(["models", "status"], 30_000);
  /* An agent that printed the whole status and then failed on an extra
     (0.6.6 throws reading a log that does not exist yet) still told us the
     status. Use it rather than turning a complete answer into an error. */
  if (!res.ok && !/^mode:/m.test(res.stdout)) return { ok: false, error: res.error };
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
      tokensPerSecond: pid && lastChatSpeed && lastChatSpeed.pid === Number(pid[1]) ? lastChatSpeed.tokensPerSecond : null,
      fault: fields["fault"] || null,
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

/* ---- ATO-119: Remove for every local model on disk, never under a server ----
   Settings › Models had no Remove for the model in use, nor for any embedding
   model (`atag models remove` takes chat models only). The window asks to stop
   the server when it knows the model is loaded; this side decides, against
   what every server of this app's could be running answers itself — not
   against what `models status` or the pid files say. Those miss a server the
   app no longer counts as its route: one left running when the route moved to
   a Custom server prints no daemon line at all (src/cli/models-handlers.ts,
   external mode), and the CLI's own guard only looks in managed mode. A server
   still on the model it ran before a pick (`models use` writes the config and
   leaves the server be) is the other case. When in doubt, nothing is deleted. */

/** The user file's word on the managed servers: their ports, the models it gives them, the data dir. */
type ManagedFacts = { chatPort: number; embPort: number; chatModel: string | null; embModel: string | null; dataDir: string };
function managedFactsFromFile(): ManagedFacts {
  type Lm = { managed?: { port?: unknown; modelId?: unknown; dataDirOverride?: unknown }; embeddings?: { port?: unknown; modelId?: unknown } };
  let lm: Lm | undefined;
  try {
    lm = (JSON.parse(readFileSync(join(DESKTOP_STATE_DIR, "config.json"), "utf8")) as { localModels?: Lm }).localModels;
  } catch {
    // no file yet: the agent's defaults
  }
  const port = (v: unknown, fallback: number) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : fallback);
  const id = (v: unknown) => (typeof v === "string" && MODEL_ID_RE.test(v) ? v : null);
  const override = lm?.managed?.dataDirOverride;
  return {
    chatPort: port(lm?.managed?.port, 19091),
    embPort: port(lm?.embeddings?.port, 19092),
    chatModel: id(lm?.managed?.modelId),
    embModel: id(lm?.embeddings?.modelId),
    dataDir: managedDataDir(typeof override === "string" ? override : null),
  };
}

/**
 * The catalogue id a managed model's file sits under: `<dataDir>/models/<id>/…`
 * (src/local-llm/backend-paths.ts resolveModelDir). Tried as written, then
 * through the file system's own spelling of both paths (/var and
 * /private/var, a Windows short name), then case-blind where the file system
 * is. Null for a file elsewhere.
 */
export function modelIdFromPath(path: string, dataDir: string): string | null {
  const under = (file: string, root: string): string | null => {
    const rel = relative(root, file);
    if (!rel || /^\.\.(?:[\\/]|$)/.test(rel) || isAbsolute(rel)) return null;
    const parts = rel.split(/[\\/]/);
    return parts.length > 1 && parts[0] ? parts[0] : null;
  };
  // The file system's spelling of a path, through its deepest part that exists.
  const real = (p: string): string => {
    try { return realpathSync.native(p); } catch { const up = dirname(p); return up === p ? p : join(real(up), basename(p)); }
  };
  const root = join(dataDir, "models");
  const folds = process.platform === "win32" || process.platform === "darwin";
  return under(path, root) ?? under(real(path), real(root))
    ?? (folds ? under(real(path).toLowerCase(), real(root).toLowerCase()) : null);
}

/** What a server answered: whether anything did, and every catalogue id its `/props` names. */
export type ServerAnswer = { answered: boolean; ids: string[] };

/**
 * Ask the llama-server at `url` what it has loaded (`/props`, with the managed
 * key when `url` is a managed server's address). Any HTTP answer at all — a
 * 401, a 503 while it loads — means a server is there. The ids come from the
 * alias the agent starts it with (`-a <id>`) and from the GGUF path it was
 * started on (`model_path`), each only when it names a catalogue model.
 */
export async function probeServer(url: string, dataDir: string, timeoutMs = 3000): Promise<ServerAnswer> {
  const key = localLlamaKeyFor(url);
  let res: Response;
  try {
    res = await fetch(llamaEndpointUrl(url, "/props"), {
      headers: { accept: "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { answered: false, ids: [] };
  }
  const ids = new Set<string>();
  try {
    if (res.ok) {
      const json = (await res.json()) as Record<string, unknown>;
      const settings = json["default_generation_settings"] as Record<string, unknown> | undefined;
      for (const v of [json["model_alias"], settings?.["model_alias"], json["model_path"], settings?.["model"], json["model"]]) {
        if (typeof v !== "string" || !v.trim()) continue;
        const s = v.trim();
        const id = /[\\/]/.test(s) ? modelIdFromPath(s, dataDir) : MODEL_ID_RE.test(s) && !/\.gguf$/i.test(s) ? s : null;
        if (id) ids.add(id);
      }
    }
  } catch {
    // an answer that is not JSON: a server is there, its model unknown
  }
  return { answered: true, ids: [...ids] };
}

/**
 * One server, as a Remove sees it: whether it is up, the model the config
 * gives it, and the ids it says it has loaded (null: it could not say).
 */
export type ServerFacts = { running: boolean; activeId: string | null; served: string[] | null };

/**
 * Why `id` may not be deleted now, or null. A server has it loaded when it
 * says so, or — when it could not say which model it runs — when it is the
 * model its config gives it.
 */
export function removeBlocker(id: string, servers: ServerFacts[]): string | null {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  for (const s of servers) {
    if (!s.running) continue;
    const loaded = s.served && s.served.length ? s.served.some((x) => same(x, id)) : s.activeId !== null && same(s.activeId, id);
    if (loaded) return "a local model server is running this model — stop it first";
  }
  return null;
}

/** A background download of `id` the agent's own worker is still driving (`<dataDir>/downloads/<kind>-<id>.json`). */
export function downloadJobRunning(dataDir: string, kind: "chat" | "embedding", id: string): boolean {
  try {
    const job = JSON.parse(readFileSync(join(dataDir, "downloads", `${kind}-${id}.json`), "utf8")) as { status?: unknown; pid?: unknown };
    if (job.status !== "running" || typeof job.pid !== "number" || !Number.isInteger(job.pid) || job.pid <= 1) return false;
    try {
      process.kill(job.pid, 0);
      return true;
    } catch (err) {
      // EPERM: alive, someone else's (a worker started under sudo).
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  } catch {
    return false;
  }
}

/**
 * Delete `<dataDir>/models/<id>`, as the agent's own removeEmbeddingModel
 * does (src/local-llm/model-installer.ts). Refused for anything but a plain
 * model id under an absolute data dir.
 */
export async function removeModelDir(dataDir: string, id: string): Promise<{ ok: boolean; error?: string }> {
  if (!MODEL_ID_RE.test(id) || id === "." || id === "..") return { ok: false, error: `not a model id: ${id}` };
  if (!dataDir || !isAbsolute(dataDir)) return { ok: false, error: "the models folder is not known" };
  const root = join(dataDir, "models");
  const dir = join(root, id);
  if (dirname(dir) !== root) return { ok: false, error: `not a model id: ${id}` };
  try {
    // A file another process has open fails a delete on Windows for a moment: retried, as Node's rm does when asked.
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Every server of this app's that could hold a model file open, asked
 * directly: the configured managed ports whatever the mode, plus the
 * addresses `models status` and `list-embeddings` report; a server whose pid
 * file says it is up but whose port does not answer counts as up, its model
 * unknown.
 */
async function serversNow(st: ModelsStatus, emb: Awaited<ReturnType<typeof modelsListEmbeddings>>, facts: ManagedFacts, dataDir: string): Promise<ServerFacts[]> {
  const chatActive = (st.mode === "managed" ? st.activeModel : null) ?? facts.chatModel;
  const embActive = (emb.models ?? []).find((m) => m.active)?.id ?? facts.embModel;
  const chatUrls = [...new Set([`http://127.0.0.1:${facts.chatPort}`, ...(st.daemonUrl ? [st.daemonUrl] : [])])];
  const embUrls = [...new Set([`http://127.0.0.1:${facts.embPort}`, ...(emb.daemon?.port ? [`http://127.0.0.1:${emb.daemon.port}`] : [])])];
  const ask = (urls: string[], activeId: string | null) => Promise.all(urls.map(async (url): Promise<ServerFacts> => {
    const a = await probeServer(url, dataDir);
    return { running: a.answered, activeId, served: a.ids.length ? a.ids : null };
  }));
  const [chat, embedding] = await Promise.all([ask(chatUrls, chatActive), ask(embUrls, embActive)]);
  const out = [...chat, ...embedding];
  if (st.daemonRunning && !chat.some((s) => s.running)) out.push({ running: true, activeId: chatActive, served: null });
  if (emb.daemon?.running && !embedding.some((s) => s.running)) out.push({ running: true, activeId: embActive, served: null });
  return out;
}

/**
 * Delete a local model's files — a chat model through `atag models remove`,
 * an embedding model's directory here, since no CLI verb removes one — unless
 * a server has it loaded (then nothing is deleted and the answer says so,
 * `running`, so the window can offer to stop it), it is still coming down, or
 * the servers' state cannot be read at all.
 */
export async function modelsRemoveSafe(kind: "chat" | "embedding", id: string): Promise<CliResult & { running?: boolean }> {
  const refuse = (error: string, running?: boolean): CliResult & { running?: boolean } =>
    ({ ok: false, stdout: "", stderr: "", error, ...(running ? { running } : {}) });
  if (!MODEL_ID_RE.test(id) || id === "." || id === "..") return refuse(`not a model id: ${id}`);
  const [status, emb] = await Promise.all([modelsStatus(), modelsListEmbeddings()]);
  if (!status.ok || !status.status) return refuse(`could not read the local model servers' state, so nothing was deleted (${status.error ?? "no answer"})`);
  const facts = managedFactsFromFile();
  const dataDir = status.status.dataDir || facts.dataDir;
  if (downloadJobRunning(dataDir, kind, id)) return refuse("it is still downloading — cancel the download first");
  const blocker = removeBlocker(id, await serversNow(status.status, emb, facts, dataDir));
  if (blocker) return refuse(blocker, true);
  if (kind === "chat") return cli(["models", "remove", id], 60_000);
  if (!emb.ok) return refuse(emb.error ?? "could not read the embedding catalogue");
  if (!(emb.models ?? []).some((m) => m.id === id)) return refuse(`not an embedding model: ${id}`);
  const gone = await removeModelDir(dataDir, id);
  return gone.ok ? { ok: true, stdout: `removed ${id}\n`, stderr: "" } : refuse(gone.error ?? "could not delete its folder");
}

/**
 * Stop the embedding server alone (`<dataDir>/llama-embed.pid`), as the
 * agent's own stopEmbeddingDaemon does: the chat server, and any turn it is
 * answering, are left be. A pid that is not a llama-server any more (reused)
 * is never touched.
 */
export async function stopEmbeddingServer(): Promise<{ ok: boolean; error?: string }> {
  const status = await modelsStatus();
  const dataDir = (status.ok && status.status?.dataDir) || managedFactsFromFile().dataDir;
  const pidFile = join(dataDir, "llama-embed.pid");
  let pid: number;
  try {
    pid = Number(readFileSync(pidFile, "utf8").trim());
  } catch {
    return { ok: true };   // no embedding server
  }
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  if (Number.isInteger(pid) && pid > 1 && alive()) {
    const command = commandOf(pid);
    if (command && /llama-server/i.test(command)) {
      try { process.kill(pid, "SIGTERM"); } catch { /* gone in between */ }
      for (let i = 0; i < 15 && alive(); i++) await new Promise((r) => setTimeout(r, 200));
      if (alive()) {
        try { process.kill(pid, "SIGKILL"); } catch { /* gone in between */ }
        for (let i = 0; i < 10 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
      }
      if (alive()) return { ok: false, error: `the embedding server (pid ${pid}) did not stop` };
    }
  }
  try { unlinkSync(pidFile); } catch { /* already gone */ }
  return { ok: true };
}

/**
 * What the managed servers run now, asked directly on their configured ports
 * (ATO-125): Settings › Models names that model as the one answering, shows a
 * server the route no longer counts, and its Use stops a server still on
 * another model, so the pick starts it on the one asked for. `answered`
 * false: no server there.
 */
export async function servedModels(): Promise<{ ok: true; chat: ServerAnswer; embedding: ServerAnswer }> {
  const facts = managedFactsFromFile();
  const [chat, embedding] = await Promise.all([
    probeServer(`http://127.0.0.1:${facts.chatPort}`, facts.dataDir, 1500),
    probeServer(`http://127.0.0.1:${facts.embPort}`, facts.dataDir, 1500),
  ]);
  return { ok: true, chat, embedding };
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
  const child = spawn(binary, ["models", "pull-embedding", id], { env: agentEnv(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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

/** `atag models update` — downloads the latest backend; stops the daemon first. `signal` kills it (backlog 18: quitting). */
export async function modelsUpdate(opts: { signal?: AbortSignal } = {}): Promise<CliResult> {
  return cli(["models", "update"], 300_000, undefined, opts.signal);
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
export type ImportSourceId = "hermes" | "openclaw" | "claude-code" | "codex" | "pi" | "oh-my-pi";
/** Domain ids each source's resolver understands, from its import-options.ts. */
export const IMPORT_DOMAINS: Record<ImportSourceId, readonly string[]> = {
  hermes: ["sessions", "cron", "secrets"],
  openclaw: ["sessions", "cron"],
  "claude-code": ["skills", "memory", "mcp", "sessions", "secrets"],
  codex: ["skills", "memory", "sessions", "secrets"],
  // agent 0.6.2 (#457): src/import/pi/import-options.ts, src/import/oh-my-pi/import-options.ts.
  pi: ["skills", "sessions"],
  "oh-my-pi": ["skills", "mcp", "sessions"],
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
  if (!domains) return { ok: false, error: "source must be hermes, openclaw, claude-code, codex, pi or oh-my-pi" };
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
  /** looksLikeAtomicChatUrl(): Atomic Chat's Local API Server port (1337). */
  atomicChat: boolean;
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

/** src/llm/describe-llama-health-failure.ts looksLikeAtomicChatUrl: the
    Local API Server port of Atomic Chat (and Jan, which it forks). */
function looksLikeAtomicChatUrl(url: string): boolean {
  try { return new URL(url).port === "1337"; } catch { return false; }
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
      // Same reasoning as Ollama: the preset row saves its own 127.0.0.1:1337, so name it only for a server on this machine.
      if (looksLikeAtomicChatUrl(url) && isLocalProviderUrl(url)) {
        return `${url} answers like Atomic Chat's Local API Server, not llama.cpp. Add it as a cloud provider instead: LLM tab › Cloud › n › Atomic Chat (local), base URL ${url}.`;
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
  // The env key, else the managed daemon's own key when this is its address (#582).
  const apiKey = localLlamaKeyFor(url);
  const headers: Record<string, string> = { accept: "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
  const start = Date.now();
  let result: LlamaProbeResult;
  try {
    const response = await fetch(llamaEndpointUrl(url, "/health"), { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      if (response.status === 503 && bodyLooksLikeLlamaLoading(text)) {
        result = { reachable: false, status: 503, kind: "llama-loading", error: "llama.cpp is still loading the model", latencyMs: Date.now() - start, message: null, ollama: false, atomicChat: false };
      } else {
        result = { reachable: false, status: response.status, kind: "unknown", error: `http ${response.status}`, latencyMs: Date.now() - start, message: null, ollama: false, atomicChat: false };
      }
    } else {
      const isLlama = bodyLooksLikeLlamaHealth(text);
      result = { reachable: isLlama, status: response.status, kind: isLlama ? "llama-server" : "unknown", error: isLlama ? null : "answered 200 but not with llama.cpp's /health shape", latencyMs: Date.now() - start, message: null, ollama: false, atomicChat: false };
    }
  } catch (err) {
    result = { reachable: false, status: null, kind: "unknown", error: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - start, message: null, ollama: false, atomicChat: false };
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
  result.atomicChat = looksLikeAtomicChatUrl(url) && isLocalProviderUrl(url);
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
  const child = spawn(binary, ["models", "update"], { env: agentEnv(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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
export function setExternalLlamaUrls(input: {
  chatUrl: string;
  embeddingUrl?: string;
}): Promise<WriteResult> {
  return withConfigLock(() => setExternalLlamaUrlsNow(input));
}

async function setExternalLlamaUrlsNow(input: {
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
  const w = await writeWholeConfig(cfg);
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
  pi: "Pi",
  "oh-my-pi": "Oh-My-Pi",
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
    // The products' `agent/` subtree, where the importable artefacts live.
    case "pi":
      return env["PI_STATE_DIR"] ?? join(home, ".pi", "agent");
    case "oh-my-pi":
      return env["OMP_STATE_DIR"] ?? join(home, ".omp", "agent");
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
    case "pi":
      return existsSync(join(dir, "skills")) || existsSync(join(dir, "sessions"));
    case "oh-my-pi":
      return existsSync(join(dir, "skills")) || existsSync(join(dir, "sessions")) || existsSync(join(dir, "mcp.json"));
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
