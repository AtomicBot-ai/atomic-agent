import { isSecretConfigKey } from "../config/config-paths.js";

/**
 * ATO-1073: the part of `config.json` that goes into a shared setup, with
 * every credential blanked.
 *
 * Only three sections are carried, by allow-list: `mcp.servers`,
 * `llm.providers` and `agent.personas.definitions`. Everything else in
 * the file is either personal (project bindings, trust answers, paths on
 * this computer) or a setting that could hold a key under a name that
 * does not look like one (a channel's webhook URL), so it stays home.
 *
 * Inside those sections a value is blanked (set to "") when:
 *  - its key is secret-named (`apiKey`, `token`, `password`, `clientSecret`;
 *    the same test `config list` masks with, isSecretConfigKey);
 *  - it sits in an `env` or `headers` map, where `GITHUB_TOKEN` or
 *    `Authorization` carries the key without a secret-looking name;
 *  - it follows a secret-named flag in `args` (`--api-key xyz`, `--token=xyz`);
 *  - it looks like a known key format anywhere (`sk-…`, `ghp_…`, `xoxb-…`).
 * A URL keeps its address but loses `user:pass@` and secret-named query
 * parameters. Every blanked spot is listed, so the recipient knows what
 * to fill in.
 */
export interface ShareableConfig {
  config: Record<string, unknown>;
  redacted: string[];
  mcpServers: string[];
  providers: string[];
  personas: string[];
}

const ALL_VALUES_MAPS = new Set(["env", "headers"]);
/**
 * Key names that hold the name of where a key lives, not the key
 * (`apiKeyEnvVar`, `extraApiKeyEnvVars`, `apiKeyHeader`): kept when the value
 * is a plain name.
 */
const NAME_KEY = /(Env|EnvVars?|Header)$/;
const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const SECRET_FLAG = /^--?[A-Za-z0-9_-]*(token|key|secret|password|passwd|auth|credential)[A-Za-z0-9_-]*$/i;
const SECRET_QUERY = /(token|key|secret|password|passwd|auth|sig|signature|code|credential)/i;
const KEY_SHAPED =
  /\b(sk-[A-Za-z0-9_-]{16,}|sk_(live|test)_[A-Za-z0-9]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,}|glpat-[A-Za-z0-9_-]{16,}|hf_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|ntn_[A-Za-z0-9]{20,})/;

export function looksLikeKey(value: string): boolean {
  return KEY_SHAPED.test(value);
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** A URL without its user info and secret-named query values; null when nothing changed. */
function redactUrl(value: string): string | null {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  let changed = false;
  if (url.username || url.password) {
    url.username = "";
    url.password = "";
    changed = true;
  }
  for (const name of [...url.searchParams.keys()]) {
    if (SECRET_QUERY.test(name) && url.searchParams.get(name)) {
      url.searchParams.set(name, "");
      changed = true;
    }
  }
  return changed ? url.toString() : null;
}

class Redactor {
  readonly redacted: string[] = [];

  value(value: unknown, path: string, key: string, blankAll: boolean): unknown {
    if (Array.isArray(value)) {
      if (key === "args") return this.args(value, path);
      return value.map((item, i) => this.value(item, `${path}[${i}]`, key, blankAll));
    }
    const obj = asObject(value);
    if (obj) {
      const out: Record<string, unknown> = {};
      for (const [child, inner] of Object.entries(obj)) {
        const all = blankAll || ALL_VALUES_MAPS.has(child.toLowerCase());
        out[child] = this.value(inner, `${path}.${child}`, child, all);
      }
      return out;
    }
    if (typeof value !== "string" || value === "") return value;
    const secretKey = isSecretConfigKey(key) && !(NAME_KEY.test(key) && PLAIN_NAME.test(value));
    if (blankAll || secretKey || looksLikeKey(value)) return this.blank(path);
    const url = redactUrl(value);
    if (url !== null) {
      this.redacted.push(path);
      return url;
    }
    return value;
  }

  private args(list: unknown[], path: string): unknown[] {
    const out: unknown[] = [];
    for (let i = 0; i < list.length; i++) {
      const arg = list[i];
      const at = `${path}[${i}]`;
      if (typeof arg !== "string") {
        out.push(arg);
        continue;
      }
      const prev = i > 0 ? list[i - 1] : undefined;
      const eq = arg.indexOf("=");
      if (arg.startsWith("-") && eq > 0 && SECRET_FLAG.test(arg.slice(0, eq)) && eq < arg.length - 1) {
        this.redacted.push(at);
        out.push(arg.slice(0, eq + 1));
      } else if (typeof prev === "string" && SECRET_FLAG.test(prev) && !arg.startsWith("-")) {
        out.push(this.blank(at));
      } else {
        out.push(this.value(arg, at, "args", false));
      }
    }
    return out;
  }

  private blank(path: string): string {
    this.redacted.push(path);
    return "";
  }
}

function named(list: unknown, idKey: string): Array<{ id: string; entry: Record<string, unknown> }> {
  if (!Array.isArray(list)) return [];
  const out: Array<{ id: string; entry: Record<string, unknown> }> = [];
  for (const raw of list) {
    const entry = asObject(raw);
    const id = entry?.[idKey];
    if (entry && typeof id === "string" && id) out.push({ id, entry });
  }
  return out;
}

export function buildShareableConfig(raw: Record<string, unknown>): ShareableConfig {
  const r = new Redactor();
  const config: Record<string, unknown> = {};
  const servers = named(asObject(raw.mcp)?.servers, "name");
  if (servers.length > 0) {
    config.mcp = {
      servers: servers.map(({ id, entry }) => r.value(entry, `mcp.servers[${id}]`, "", false)),
    };
  }
  const providers = named(asObject(raw.llm)?.providers, "id");
  if (providers.length > 0) {
    config.llm = {
      providers: providers.map(({ id, entry }) => r.value(entry, `llm.providers[${id}]`, "", false)),
    };
  }
  const definitions = asObject(asObject(asObject(raw.agent)?.personas)?.definitions) ?? {};
  const personas = Object.keys(definitions);
  if (personas.length > 0) {
    config.agent = {
      personas: { projects: {}, definitions: r.value(definitions, "agent.personas.definitions", "", false) },
    };
  }
  return {
    config,
    redacted: r.redacted,
    mcpServers: servers.map((s) => s.id),
    providers: providers.map((p) => p.id),
    personas,
  };
}
