import { looksLikeSecretRef, readSecretSources, type SecretSources } from "./secret-refs.js";
import { resolveSecretRefSync, type SyncSecretSpawner } from "./secret-ref-resolver.js";

/**
 * `.env` and keychain values written as references (ATO-2339):
 * `OPENROUTER_API_KEY=op://Private/OpenRouter/credential` puts the real
 * key in `process.env` for this process only. The file keeps the
 * reference, so `config secrets get`, `GET /api/secrets/{name}` and the
 * desktop app show the reference, never the value, and nothing writes
 * the value back.
 *
 * A reference that cannot be resolved is removed from `process.env` and
 * reported by name on stderr: the agent then runs as if the key were not
 * set, instead of sending `op://…` to a provider as a key.
 */
export interface DotenvSecretRefsResult {
  /** Names now holding a resolved value. Never values. */
  resolved: string[];
  /** Names whose reference failed, with the reason (never a value). */
  failed: { name: string; reason: string }[];
}

export interface DotenvSecretRefsDeps {
  env?: NodeJS.ProcessEnv;
  sources?: SecretSources;
  spawn?: SyncSecretSpawner;
  warn?: (message: string) => void;
}

/**
 * Resolve the references among `names` (the variables the `.env` and
 * keychain loaders just applied). A name the shell had already set is
 * not in `names` and is left alone. Returns null when there was none,
 * which costs one prefix test per name and never reads the sources file.
 */
export function resolveDotenvSecretRefs(
  stateDir: string,
  names: readonly string[],
  deps: DotenvSecretRefsDeps = {},
): DotenvSecretRefsResult | null {
  const env = deps.env ?? process.env;
  const refs = names.filter((name) => {
    const value = env[name];
    return typeof value === "string" && looksLikeSecretRef(value);
  });
  if (refs.length === 0) return null;
  const warn = deps.warn ?? ((m: string) => process.stderr.write(`atomic-agent: ${m}\n`));
  const sources = deps.sources ?? readSecretSources(stateDir, warn);
  const result: DotenvSecretRefsResult = { resolved: [], failed: [] };
  for (const name of refs) {
    const ref = env[name]!;
    try {
      env[name] = resolveSecretRefSync(name, ref, {
        sources,
        env,
        ...(deps.spawn === undefined ? {} : { spawn: deps.spawn }),
      });
      result.resolved.push(name);
    } catch (err) {
      delete env[name];
      const reason = err instanceof Error ? err.message : String(err);
      result.failed.push({ name, reason });
      warn(`could not resolve the secret reference in ${name} (${reason}); it is not set this run.`);
    }
  }
  return result;
}
