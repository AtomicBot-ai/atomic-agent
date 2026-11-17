/**
 * A provider key that comes from a command instead of a stored value
 * (`apiKeyCommand`), for services whose credential is a short-lived
 * token: Google Vertex AI takes an OAuth access token from
 * `gcloud auth print-access-token`, valid for about an hour.
 *
 * - The command runs as an argv array through `execFile`, never through a
 *   shell, so nothing in it is expanded or interpolated.
 * - Its output is cached briefly ({@link API_KEY_COMMAND_TTL_MS}, well
 *   under the token's hour) and re-run when the cache runs out or the
 *   service answers 401 (`openAiFetch` calls `invalidate`).
 * - The output is never logged and never put into an error message: a
 *   failure names the command and how it failed, not what it printed.
 *   The latest value per provider is offered to the secret scrubber
 *   through {@link commandIssuedSecrets}, so a token echoed back into
 *   tool output or a trace is masked like a stored key.
 */

import { execFile } from "node:child_process";

/** How long one command output is reused before the command runs again. */
export const API_KEY_COMMAND_TTL_MS = 5 * 60 * 1000;
/** The command gets this long to print a token. */
export const API_KEY_COMMAND_TIMEOUT_MS = 15_000;
/** A token is a few KB at most; anything larger is not a token. */
const API_KEY_COMMAND_MAX_BUFFER = 64 * 1024;

/** A key the request path asks for each time instead of holding one. */
export interface ApiKeySource {
  /** The current key: the cached output, or a fresh run of the command. */
  get(): Promise<string>;
  /** Drop the cached output, so the next `get` runs the command again. */
  invalidate(): void;
}

/** Runs `argv` and resolves its stdout. Injected by tests. */
export type RunKeyCommand = (
  argv: readonly string[],
  timeoutMs: number,
) => Promise<string>;

export interface ApiKeyCommandOptions {
  /** Provider id: names the command in errors and labels the secret. */
  readonly label: string;
  readonly ttlMs?: number;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly run?: RunKeyCommand;
}

/** The latest output of each provider's key command, for the scrubber. */
const issued = new Map<string, string>();

/**
 * The values key commands have printed in this process, one per provider,
 * shaped like `KnownSecret` (`runtimeKnownSecrets` adds them to the exact
 * values masked in tool output and traces).
 */
export function commandIssuedSecrets(): { label: string; value: string }[] {
  return [...issued].map(([label, value]) => ({ label, value }));
}

/** One source per provider and command, shared by every provider instance. */
const shared = new Map<string, ApiKeySource>();

/**
 * The source for `label`'s command, created once per process. A provider
 * is rebuilt on every model switch and fallback pick; sharing the source
 * keeps one cached token instead of running the command each time.
 */
export function sharedApiKeyCommandSource(
  argv: readonly string[],
  label: string,
): ApiKeySource {
  const key = `${label}\0${argv.join("\0")}`;
  let source = shared.get(key);
  if (!source) {
    source = createApiKeyCommandSource(argv, { label });
    shared.set(key, source);
  }
  return source;
}

/** Test seam: forget every issued value and shared source. */
export function resetCommandIssuedSecrets(): void {
  issued.clear();
  shared.clear();
}

export function createApiKeyCommandSource(
  argv: readonly string[],
  options: ApiKeyCommandOptions,
): ApiKeySource {
  if (argv.length === 0 || argv.some((part) => part.length === 0)) {
    throw new Error(`apiKeyCommand for "${options.label}" must be a non-empty list of non-empty strings`);
  }
  const ttlMs = options.ttlMs ?? API_KEY_COMMAND_TTL_MS;
  const timeoutMs = options.timeoutMs ?? API_KEY_COMMAND_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const run = options.run ?? runKeyCommand;
  const secretLabel = `${options.label}-key-command`;
  let cached: { value: string; at: number } | null = null;
  // Concurrent turns share one run instead of starting the command twice.
  let pending: Promise<string> | null = null;

  const refresh = async (): Promise<string> => {
    let stdout: string;
    try {
      stdout = await run(argv, timeoutMs);
    } catch (err) {
      throw new Error(
        `apiKeyCommand for "${options.label}" failed (${argv[0]}): ${describeRunFailure(err)}`,
      );
    }
    const value = stdout.trim();
    if (value.length === 0 || /\s/.test(value)) {
      // Never echo the output: it may be a token with a stray line.
      throw new Error(
        `apiKeyCommand for "${options.label}" printed ${value.length === 0 ? "nothing" : "more than one token"} (${argv[0]})`,
      );
    }
    issued.set(secretLabel, value);
    cached = { value, at: now() };
    return value;
  };

  return {
    async get(): Promise<string> {
      if (cached && now() - cached.at < ttlMs) return cached.value;
      pending ??= refresh().finally(() => {
        pending = null;
      });
      return pending;
    },
    invalidate(): void {
      cached = null;
    },
  };
}

/**
 * Why a run failed, without anything the command printed: the exit code,
 * a timeout, or "not found". stderr is left out too, since a credential
 * helper may print a token or account detail there.
 */
function describeRunFailure(err: unknown): string {
  const e = err as { code?: unknown; killed?: boolean; signal?: unknown } | null;
  if (e?.code === "ENOENT") return "command not found";
  if (e?.killed || e?.signal === "SIGTERM") return "timed out";
  if (typeof e?.code === "number") return `exit code ${e.code}`;
  if (typeof e?.code === "string") return e.code;
  return "could not run";
}

const runKeyCommand: RunKeyCommand = (argv, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      argv[0]!,
      argv.slice(1),
      {
        timeout: timeoutMs,
        maxBuffer: API_KEY_COMMAND_MAX_BUFFER,
        windowsHide: true,
        encoding: "utf8",
      },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      },
    );
  });
