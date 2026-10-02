/**
 * ATO-132 — where a provider's API key is kept.
 *
 * The key field says "Saved to .env as AIMLAPI_API_KEY (mode 0600)", which
 * is what the terminal agent does (src/tui/persist-llm-provider.ts
 * writeProviderApiKeyToDotenv): the key goes into `<stateDir>/.env`, owner
 * read/write only, and the provider entry in config.json names the variable
 * (`apiKeyEnvVar`), which the agent reads before anything else
 * (src/config/resolve-llm-api-key.ts). The desktop wrote the key into
 * config.json instead: a file other accounts could read, and one every
 * whole-file config write hands to `atag config set` on its command line.
 *
 * This module is the pure half: which variable a key goes in, which key the
 * agent will send for an entry, and the .env text the agent reads back. The
 * file writes are in agent-cli.ts. Dependency-free, so the suite can drive it
 * against the built output (test/provider-keys.test.mjs). Key values pass
 * through here only to be compared or written into text a caller asked for.
 */

/** A name `.env` can carry (load-dotenv.ts KEY_PATTERN). */
export const KEY_VAR = /^[A-Z_][A-Z0-9_]*$/;

/** What this module reads of a provider entry. */
export interface KeyedProvider {
  id?: unknown;
  kind?: unknown;
  apiKey?: unknown;
  apiKeyEnvVar?: unknown;
}

/** The environment `atag` inherits; a name set there wins over `.env`. */
export type KeyEnv = Readonly<Record<string, string | undefined>>;

/** The variable a built-in cloud kind reads when its entry names none (resolve-llm-api-key.ts). */
export function kindKeyVar(kind: unknown): string | null {
  if (kind === "openrouter") return "OPENROUTER_API_KEY";
  if (kind === "aimlapi") return "AIMLAPI_API_KEY";
  if (kind === "gemini") return "GEMINI_API_KEY";
  return null;
}

/** The shared chain an OpenAI-compatible entry with no variable of its own falls back to. */
const COMPAT_CHAIN = ["OPENAI_COMPAT_API_KEY", "OPENAI_API_KEY", "ATOMIC_AGENT_OPENAI_API_KEY"] as const;

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/**
 * The variables the agent reads this entry's key from — none while the entry
 * carries its own key, since that one wins (resolveLlmProviderApiKey).
 */
export function keyVarsReadBy(p: KeyedProvider): string[] {
  if (!p || nonEmpty(p.apiKey)) return [];
  if (nonEmpty(p.apiKeyEnvVar)) return [p.apiKeyEnvVar];
  const own = kindKeyVar(p.kind);
  if (own) return [own];
  if (p.kind === "openai-compatible" || p.kind === "qwen-openai-compatible") return [...COMPAT_CHAIN];
  return [];
}

/**
 * The variable named after the entry: `groq` → GROQ_API_KEY,
 * `openrouter-2` → OPENROUTER_2_API_KEY, `custom-api-example-com` →
 * CUSTOM_API_EXAMPLE_COM_API_KEY. Every preset's own variable is exactly
 * this (renderer PRESETS), so a preset keeps the name its row shows.
 */
export function idKeyVar(id: string): string {
  const stem = String(id).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "PROVIDER";
  return `${/^[A-Z]/.test(stem) ? stem : `PROVIDER_${stem}`}_API_KEY`;
}

/* ---------------------------------------------------------------
   The .env text, as src/config/load-dotenv.ts reads it.
   --------------------------------------------------------------- */

/**
 * `<stateDir>/.env` as the agent applies it to an environment that does not
 * set these names: `KEY=VALUE` per line, trimmed, `#` comments skipped, one
 * matching pair of outer quotes stripped, nothing unescaped. A name is set
 * by its first line with a value; an empty line for it is overwritten by a
 * later one (load-dotenv.ts skips a name only once it holds a value).
 */
export function parseDotenvAsAgent(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const name = t.slice(0, eq).trim();
    if (!KEY_VAR.test(name)) continue;
    let value = t.slice(eq + 1).trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) value = value.slice(1, -1);
    }
    const had = out.get(name);
    if (had !== undefined && had.length > 0) continue;
    out.set(name, value);
  }
  return out;
}

/**
 * src/config/dotenv-writer.ts setDotenvKey's text edit: set (or, with
 * `null`, remove) one name, keeping comments, blank lines, order and every
 * other name. Returns null for the removal of a name that is not there.
 */
export function applyDotenvMutation(original: string, key: string, value: string | null): string | null {
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

/**
 * A value as the loader reads it back unchanged. It strips one pair of outer
 * quotes and unescapes nothing, so a value that needs quoting (whitespace, a
 * quote, `#`, a backslash) is wrapped in a pair it does not end with, and
 * never escaped: the agent's own writer escapes `\` and `"`, and those came
 * back doubled. A line break cannot be carried at all (parseDotenvAsAgent
 * reads lines); storeKeys checks the round trip.
 */
export function formatDotenvValue(value: string): string {
  if (value.length === 0) return "";
  if (!/[\s"'#\\]/.test(value)) return value;
  return value.includes('"') ? `'${value}'` : `"${value}"`;
}

function joinDotenvLines(lines: string[]): string {
  if (lines.length === 0) return "";
  return `${lines.join("\n")}\n`;
}

/* ---------------------------------------------------------------
   Which key the agent sends.
   --------------------------------------------------------------- */

/** One name as the agent sees it after load-dotenv.ts: the environment's value when it has one, else `.env`'s. */
export function agentEnvValue(name: string, env: KeyEnv, dotenv: ReadonlyMap<string, string>): string | undefined {
  const fromEnv = env[name];
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  const fromFile = dotenv.get(name);
  return fromFile !== undefined ? fromFile : fromEnv;
}

/**
 * The key the agent will send for this entry (resolveLlmProviderApiKey,
 * after load-dotenv.ts): its own `apiKey`, else its `apiKeyEnvVar` — which
 * is authoritative, with no fallback — else its kind's variable. Never
 * logged; it leaves here only to be compared or put in a header.
 */
export function agentKeyFor(p: KeyedProvider, env: KeyEnv, dotenv: ReadonlyMap<string, string>): string | undefined {
  if (!p) return undefined;
  if (nonEmpty(p.apiKey)) return p.apiKey;
  const read = (name: string) => agentEnvValue(name, env, dotenv);
  const set = (v: string | undefined) => (v !== undefined && v.length > 0 ? v : undefined);
  if (nonEmpty(p.apiKeyEnvVar)) return set(read(p.apiKeyEnvVar));
  const own = kindKeyVar(p.kind);
  if (own) return set(read(own));
  if (p.kind === "openai-compatible" || p.kind === "qwen-openai-compatible") {
    return set(read(COMPAT_CHAIN[0]) ?? read(COMPAT_CHAIN[1]) ?? read(COMPAT_CHAIN[2]));
  }
  return undefined;
}

/**
 * Ids whose key would change between two states — the same providers, as
 * they would be read with each `.env`. `skip` names entries that are meant
 * to change (the one a key was just typed for).
 */
export function keyChanges(
  before: ReadonlyArray<KeyedProvider>,
  after: ReadonlyArray<KeyedProvider>,
  env: KeyEnv,
  dotenvBefore: ReadonlyMap<string, string>,
  dotenvAfter: ReadonlyMap<string, string>,
  skip: ReadonlySet<string> = new Set(),
): string[] {
  const changed: string[] = [];
  for (const b of before) {
    if (!b || typeof b.id !== "string" || skip.has(b.id)) continue;
    const a = after.find((x) => x && x.id === b.id);
    if (!a) continue;
    if (agentKeyFor(b, env, dotenvBefore) !== agentKeyFor(a, env, dotenvAfter)) changed.push(b.id);
  }
  return changed;
}

/* ---------------------------------------------------------------
   Which variable a key goes in.
   --------------------------------------------------------------- */

export interface KeyVarChoice {
  id: string;
  key: string;
  /** Names this entry may write over, in order: the one it reads now, its row's, its kind's. */
  preferred: ReadonlyArray<unknown>;
  /** Every other entry, as the agent will read it. */
  others: ReadonlyArray<KeyedProvider>;
  /** Names given to other entries in the same write. */
  taken?: ReadonlySet<string>;
  env: KeyEnv;
  /** `<stateDir>/.env` as the agent reads it. */
  dotenv: ReadonlyMap<string, string>;
}

/**
 * The `.env` variable to keep this entry's key in, or null when none will do.
 *
 * A name will not do when another entry reads its key from it (writing there
 * would change that provider's key too), or when this app's environment sets
 * it to something else: the agent takes the environment's value over
 * `.env`'s, and the key typed here would never be sent. The entry's own names
 * — the one it reads, its row's, its kind's, the one named after it — are
 * written over, as re-keying does; a numbered spare only when `.env` does not
 * already hold something else under it.
 */
export function chooseKeyVar(c: KeyVarChoice): string | null {
  const claimed = new Set<string>(c.taken ?? []);
  for (const o of c.others) if (o && o.id !== c.id) for (const name of keyVarsReadBy(o)) claimed.add(name);
  const shadowed = (name: string): boolean => {
    const v = c.env[name];
    return typeof v === "string" && v.length > 0 && v !== c.key;
  };
  const own: string[] = [];
  for (const name of [...c.preferred, idKeyVar(c.id)]) {
    if (typeof name === "string" && KEY_VAR.test(name) && !own.includes(name)) own.push(name);
  }
  for (const name of own) if (!claimed.has(name) && !shadowed(name)) return name;
  const base = idKeyVar(c.id);
  for (let i = 2; i <= 20; i += 1) {
    const name = `${base}_${i}`;
    const there = c.dotenv.get(name);
    if (claimed.has(name) || shadowed(name) || (there !== undefined && there.length > 0 && there !== c.key)) continue;
    return name;
  }
  return null;
}

export interface KeyMove {
  /** Index in the provider list. */
  index: number;
  id: string;
  /** The variable the key moves to. */
  name: string;
  key: string;
}

/**
 * The startup migration's plan: every entry holding its own key, the
 * variable it moves to. An entry no variable will do for is `stuck` and
 * keeps its key where it is.
 */
export function planKeyMoves(
  providers: ReadonlyArray<KeyedProvider>,
  env: KeyEnv,
  dotenv: ReadonlyMap<string, string>,
): { moves: KeyMove[]; stuck: string[] } {
  const moves: KeyMove[] = [];
  const stuck: string[] = [];
  const taken = new Set<string>();
  providers.forEach((p, index) => {
    if (!p || !nonEmpty(p.apiKey)) return;
    const id = typeof p.id === "string" ? p.id : "";
    const name = id
      ? chooseKeyVar({ id, key: p.apiKey, preferred: [p.apiKeyEnvVar, kindKeyVar(p.kind)], others: providers.filter((o) => o !== p), taken, env, dotenv })
      : null;
    if (!name) { stuck.push(id); return; }
    taken.add(name);
    moves.push({ index, id, name, key: p.apiKey });
  });
  return { moves, stuck };
}

/** `text` with every occurrence of each key replaced, for a line that might quote one back (an error from a write). */
export function redactKeys(text: string, keys: ReadonlyArray<string>): string {
  let out = String(text);
  for (const k of keys) if (k && k.length >= 4) out = out.split(k).join("<key>");
  return out;
}
