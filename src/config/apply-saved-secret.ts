import { looksLikeSecretRef, readSecretSources } from "./secret-refs.js";
import {
  forgetSecretRef,
  resolveSecretRef,
  resolveSecretRefSync,
  type SecretSpawner,
  type SyncSecretSpawner,
} from "./secret-ref-resolver.js";

/**
 * A key just saved mid-session (`/providers`, an integration field,
 * `PUT /api/secrets/{name}`) goes into this process's environment at
 * once, so the running agent uses it without a restart. ATO-2530: when
 * the saved text is a reference (`op://…`, `bw://…`, `vault://…`,
 * `cmd://…`), the environment gets the resolved value, as at start
 * (`dotenv-secret-refs.ts`); before, it got the reference itself, and the
 * provider was sent `op://…` as its key until the next start.
 *
 * A reference that cannot be resolved leaves the variable unset (never
 * the reference) and comes back as `error`, which names the variable and
 * the program, never a value.
 */
export interface AppliedSecret {
  /** True when the saved text was a reference and its value is now in the environment. */
  resolved: boolean;
  /** Why a reference could not be resolved. */
  error?: string;
}

export interface ApplySavedSecretDeps {
  env?: NodeJS.ProcessEnv;
  spawn?: SyncSecretSpawner;
}

function plain(name: string, value: string | null, env: NodeJS.ProcessEnv): AppliedSecret | null {
  if (value === null) {
    delete env[name];
    return { resolved: false };
  }
  if (!looksLikeSecretRef(value)) {
    env[name] = value;
    return { resolved: false };
  }
  return null;
}

function failed(name: string, env: NodeJS.ProcessEnv, err: unknown): AppliedSecret {
  delete env[name];
  return { resolved: false, error: err instanceof Error ? err.message : String(err) };
}

/** Synchronous, for the terminal's save paths. */
export function applySavedSecretToEnv(
  stateDir: string,
  name: string,
  value: string | null,
  deps: ApplySavedSecretDeps = {},
): AppliedSecret {
  const env = deps.env ?? process.env;
  const done = plain(name, value, env);
  if (done !== null) return done;
  // A save reads the reference again: the key may have been rotated.
  forgetSecretRef(name, value!);
  try {
    env[name] = resolveSecretRefSync(name, value!, {
      sources: readSecretSources(stateDir),
      env,
      ...(deps.spawn === undefined ? {} : { spawn: deps.spawn }),
    });
    return { resolved: true };
  } catch (err) {
    return failed(name, env, err);
  }
}

/** Asynchronous, for the HTTP route (an `op` waiting on Touch ID does not block serve). */
export async function applySavedSecretToEnvAsync(
  stateDir: string,
  name: string,
  value: string | null,
  deps: { env?: NodeJS.ProcessEnv; spawn?: SecretSpawner } = {},
): Promise<AppliedSecret> {
  const env = deps.env ?? process.env;
  const done = plain(name, value, env);
  if (done !== null) return done;
  forgetSecretRef(name, value!);
  try {
    env[name] = await resolveSecretRef(name, value!, {
      sources: readSecretSources(stateDir),
      env,
      ...(deps.spawn === undefined ? {} : { spawn: deps.spawn }),
    });
    return { resolved: true };
  } catch (err) {
    return failed(name, env, err);
  }
}
