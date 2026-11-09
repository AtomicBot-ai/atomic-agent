import { posix, win32 } from "node:path";

/**
 * The environment a vendor CLI is spawned with: the agent's own, minus
 * the variables that would move the CLI off the user's subscription.
 *
 * The agent's environment is not the user's shell. It carries the keys
 * of every other provider configured here — the `anthropic` provider's
 * `ANTHROPIC_API_KEY` from `.env` among them — and `claude` prefers an
 * API key it finds in its environment over the subscription it is
 * signed in with. Inherited untouched, a user who picked "Claude Code
 * subscription" was billed per token on that key, or saw the turn fail
 * with "credit balance too low" on an account they never meant to use.
 * Someone who wants API billing has the provider for that.
 *
 * Matched without regard to case: Windows environment names are
 * case-insensitive, so `Anthropic_Api_Key` reaches the CLI as the same
 * variable.
 */
export function cliChildEnv(
  strip: readonly string[] | undefined,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (strip === undefined || strip.length === 0) return base;
  const drop = new Set(strip.map((key) => key.toUpperCase()));
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (!drop.has(key.toUpperCase())) env[key] = value;
  }
  return env;
}

/**
 * Put the folder of an absolutely pathed CLI on the child's PATH
 * (ATO-756).
 *
 * The desktop saves `subscriptionCli.binPath` when it finds the CLI in a
 * folder the app's own PATH lacks (an app opened from the Dock gets
 * `/usr/bin:/bin:/usr/sbin:/sbin`). An npm-installed `claude` or `codex`
 * is a `#!/usr/bin/env node` script, and the `node` it needs sits in that
 * same folder (Homebrew, Volta, a global npm prefix); without it the
 * spawn dies with "env: node: No such file or directory". Appended, never
 * prepended, so nothing already on PATH is shadowed. A bare name is left
 * alone: PATH already found it.
 */
export function withBinaryDirOnPath(
  env: NodeJS.ProcessEnv,
  binary: string,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const path = platform === "win32" ? win32 : posix;
  if (!path.isAbsolute(binary)) return env;
  const dir = path.dirname(binary);
  const key =
    Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const sep = platform === "win32" ? ";" : ":";
  const current = env[key] ?? "";
  const dirs = current.split(sep);
  if (dirs.includes(dir)) return env;
  return { ...env, [key]: current ? `${current}${sep}${dir}` : dir };
}
