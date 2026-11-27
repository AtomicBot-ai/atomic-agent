import { execFile, spawnSync } from "node:child_process";

import { rememberResolvedSecret } from "../sandbox/resolved-secret-values.js";
import { missingCliMessage } from "./secret-ref-install-hint.js";
import {
  parseSecretRef,
  planSecretRef,
  type SecretRef,
  type SecretRefPlan,
  type SecretSources,
} from "./secret-refs.js";
import {
  fetchVault,
  fetchVaultSync,
  planVaultRequest,
  vaultFieldOf,
  type VaultRequest,
  type VaultResponse,
} from "./vault-secret-ref.js";

/**
 * Runs secret references (`secret-refs.ts`) and keeps their values in
 * process memory (ATO-2339, ATO-476).
 *
 * - One command per reference, argv only, `timeoutMs` (3 s by default),
 *   stdout capped at {@link SECRET_REF_MAX_OUTPUT_BYTES}.
 * - The value is cached here and registered with the secret detector
 *   (`resolved-secret-values.ts`), so it is masked wherever tool output,
 *   an error or a trace would carry it. It is never written to disk.
 * - A failure names the variable, the program and how it failed. Never
 *   stdout; stderr's first line only, with the value cut out of it.
 *
 * Two runners share the logic: `.env` loading is synchronous (the config
 * loader runs before anything async), a tool call is not.
 */

/** A secret is a few KB at most; past 1 MiB the output is not a secret. */
export const SECRET_REF_MAX_OUTPUT_BYTES = 1024 * 1024;

export interface SecretSpawnOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** Why the command did not finish normally, or null when it did. */
  failure: "timeout" | "too-large" | "not-found" | "could-not-run" | null;
}

export interface SecretSpawnOptions {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBytes: number;
  /** Windows `cmd.exe /c` line passed as written (`SecretRefPlan.verbatim`, ATO-2530). */
  verbatim?: boolean;
  /** The folder to start in (`SecretRefPlan.cwd`); unset means this process's. */
  cwd?: string;
}

/** A Vault request runner (ATO-2530); tests pass a fake, production uses `fetch`. */
export type SyncVaultFetcher = (request: VaultRequest, timeoutMs: number) => VaultResponse;
export type VaultFetcher = (request: VaultRequest, timeoutMs: number) => Promise<VaultResponse>;

export type SyncSecretSpawner = (argv: readonly string[], options: SecretSpawnOptions) => SecretSpawnOutcome;
export type SecretSpawner = (argv: readonly string[], options: SecretSpawnOptions) => Promise<SecretSpawnOutcome>;

export class SecretRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretRefError";
  }
}

/** reference + key -> value, for this process only. */
const cache = new Map<string, string>();

/** Test seam: forget every cached value. */
export function resetSecretRefCache(): void {
  cache.clear();
}

function cacheKeyOf(ref: SecretRef, value: string): string {
  return ref.kind === "command" ? `cmd\0${ref.key}` : value.trim();
}

/**
 * Forget the cached value of `value` (a reference saved under `name`), so
 * the next resolve reads it again. A key saved again after a rotation in
 * 1Password, Bitwarden or Vault keeps the same reference text; without
 * this the old value would come back until a restart (review F2102.4).
 */
export function forgetSecretRef(name: string, value: string): void {
  const ref = parseSecretRef(value, name);
  if (ref === null || typeof ref === "string") return;
  cache.delete(cacheKeyOf(ref, value));
}

type Prepared =
  | { cached: string }
  | { cacheKey: string; plan: SecretRefPlan }
  | { cacheKey: string; vault: VaultRequest };

function prepare(name: string, value: string, sources: SecretSources, env: NodeJS.ProcessEnv): Prepared {
  const ref = parseSecretRef(value, name);
  if (ref === null) throw new SecretRefError(`${name} is not a secret reference`);
  if (typeof ref === "string") throw new SecretRefError(`${name}: ${ref}`);
  const cacheKey = cacheKeyOf(ref, value);
  const hit = cache.get(cacheKey);
  if (hit !== undefined) {
    rememberResolvedSecret(name, hit);
    return { cached: hit };
  }
  if (ref.kind === "vault") {
    const request = planVaultRequest(ref, env);
    if (typeof request === "string") throw new SecretRefError(`${name}: ${request}`);
    return { cacheKey, vault: request };
  }
  const plan = planSecretRef(ref, sources, env);
  if (typeof plan === "string") throw new SecretRefError(`${name}: ${plan}`);
  return { cacheKey, plan };
}

/** The Vault field as the value, cached and masked like a CLI's output. */
function finishVault(name: string, cacheKey: string, request: VaultRequest, response: VaultResponse): string {
  const out = vaultFieldOf(response, request);
  if ("error" in out) throw new SecretRefError(`${name}: ${out.error}`);
  if (out.value.length === 0) throw new SecretRefError(`${name}: the Vault field is empty`);
  if (/[\r\n\0]/.test(out.value)) throw new SecretRefError(`${name}: the Vault field is more than one line`);
  cache.set(cacheKey, out.value);
  rememberResolvedSecret(name, out.value);
  return out.value;
}

function spawnOptions(plan: SecretRefPlan): SecretSpawnOptions {
  return {
    env: plan.env,
    timeoutMs: plan.timeoutMs,
    maxBytes: SECRET_REF_MAX_OUTPUT_BYTES,
    ...(plan.verbatim === true ? { verbatim: true } : {}),
    ...(plan.cwd === undefined ? {} : { cwd: plan.cwd }),
  };
}

/** The first stderr line, capped, with the value (if any) removed. */
function stderrHint(stderr: string, value: string): string {
  let line = stderr.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? "";
  if (value.length > 0) line = line.split(value).join("[redacted]");
  if (line.length > 200) line = `${line.slice(0, 200)}…`;
  return line.length > 0 ? `: ${line}` : "";
}

function finish(name: string, prepared: { cacheKey: string; plan: SecretRefPlan }, out: SecretSpawnOutcome): string {
  const program = prepared.plan.program;
  // One trailing newline is the CLI's, not the secret's.
  const value = out.stdout.replace(/\r?\n$/, "");
  if (out.failure === "not-found") {
    throw new SecretRefError(missingCliMessage(name, program, "not-found") ?? `${name}: ${program} was not found`);
  }
  if (out.failure === "timeout") throw new SecretRefError(`${name}: ${program} timed out`);
  if (out.failure === "too-large") {
    throw new SecretRefError(`${name}: ${program} printed more than ${SECRET_REF_MAX_OUTPUT_BYTES} bytes`);
  }
  if (out.failure === "could-not-run") {
    throw new SecretRefError(missingCliMessage(name, program, "could-not-run") ?? `${name}: ${program} could not run`);
  }
  if (out.exitCode !== 0) {
    throw new SecretRefError(
      `${name}: ${program} failed (exit code ${out.exitCode ?? "none"})${stderrHint(out.stderr, value)}`,
    );
  }
  if (value.length === 0) throw new SecretRefError(`${name}: ${program} printed nothing`);
  if (/[\r\n\0]/.test(value)) throw new SecretRefError(`${name}: ${program} printed more than one line`);
  cache.set(prepared.cacheKey, value);
  rememberResolvedSecret(name, value);
  return value;
}

export interface ResolveSecretRefDeps {
  sources: SecretSources;
  env?: NodeJS.ProcessEnv;
}

/** Vault requests wait as long as a `cmd://` helper may run. */
function vaultTimeout(sources: SecretSources): number {
  return sources.timeoutMs;
}

/** Resolve `value` (a reference saved under `name`) synchronously. Throws `SecretRefError`. */
export function resolveSecretRefSync(
  name: string,
  value: string,
  deps: ResolveSecretRefDeps & { spawn?: SyncSecretSpawner; fetchVault?: SyncVaultFetcher },
): string {
  const prepared = prepare(name, value, deps.sources, deps.env ?? process.env);
  if ("cached" in prepared) return prepared.cached;
  if ("vault" in prepared) {
    const fetch = deps.fetchVault ?? fetchVaultSync;
    return finishVault(name, prepared.cacheKey, prepared.vault, fetch(prepared.vault, vaultTimeout(deps.sources)));
  }
  const spawn = deps.spawn ?? spawnSecretSync;
  return finish(name, prepared, spawn(prepared.plan.argv, spawnOptions(prepared.plan)));
}

/** Resolve `value` (a reference saved under `name`). Rejects with `SecretRefError`. */
export async function resolveSecretRef(
  name: string,
  value: string,
  deps: ResolveSecretRefDeps & { spawn?: SecretSpawner; fetchVault?: VaultFetcher },
): Promise<string> {
  const prepared = prepare(name, value, deps.sources, deps.env ?? process.env);
  if ("cached" in prepared) return prepared.cached;
  if ("vault" in prepared) {
    const fetch = deps.fetchVault ?? fetchVault;
    return finishVault(name, prepared.cacheKey, prepared.vault, await fetch(prepared.vault, vaultTimeout(deps.sources)));
  }
  const spawn = deps.spawn ?? spawnSecret;
  return finish(name, prepared, await spawn(prepared.plan.argv, spawnOptions(prepared.plan)));
}

function failureOf(err: unknown): SecretSpawnOutcome["failure"] {
  const e = err as { code?: unknown; killed?: boolean; signal?: unknown } | null;
  if (e === null || e === undefined) return null;
  if (e.code === "ENOENT") return "not-found";
  // Before the timeout test: an over-long output is killed too.
  if (e.code === "ENOBUFS" || e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "too-large";
  if (e.code === "ETIMEDOUT" || e.killed === true || e.signal === "SIGTERM") return "timeout";
  return typeof e.code === "number" ? null : "could-not-run";
}

/** The production synchronous runner: `spawnSync`, no shell, no stdin. */
export const spawnSecretSync: SyncSecretSpawner = (argv, options) => {
  const r = spawnSync(argv[0]!, argv.slice(1), {
    env: options.env,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    timeout: options.timeoutMs,
    maxBuffer: options.maxBytes,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    windowsVerbatimArguments: options.verbatim === true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const failure = r.error ? failureOf(r.error) ?? "could-not-run" : r.signal !== null ? "could-not-run" : null;
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.status, failure };
};

/** The production runner: `execFile`, no shell. */
export const spawnSecret: SecretSpawner = (argv, options) =>
  new Promise((resolve) => {
    const child = execFile(
      argv[0]!,
      argv.slice(1),
      {
        env: options.env,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        timeout: options.timeoutMs,
        maxBuffer: options.maxBytes,
        encoding: "utf8",
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: options.verbatim === true,
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ stdout, stderr, exitCode: 0, failure: null });
          return;
        }
        const code = (err as { code?: unknown }).code;
        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode: typeof code === "number" ? code : null,
          failure: failureOf(err),
        });
      },
    );
    child.stdin?.end();
  });
