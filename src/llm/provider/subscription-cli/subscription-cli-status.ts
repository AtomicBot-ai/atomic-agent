import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { posix, win32 } from "node:path";

import type { SubscriptionCliName } from "../../../config/llm-config.js";
import type { CliAdapterDescriptor } from "./cli-adapter-descriptor.js";
import { resolveCliBinary } from "./resolve-cli-binary.js";
import { runCliCommand, type CliRunner } from "./run-cli-completion.js";
import { SubscriptionCliAuthError, SubscriptionCliNotInstalledError } from "./subscription-cli-errors.js";

/**
 * ATO-1200: is a subscription CLI ready to answer, without spending the plan?
 *
 *   missing     the binary is not there
 *   signed_out  installed, and the CLI (or its login file) says no login
 *   ready       installed and signed in
 *   unknown     installed, but the login cannot be told apart without a real
 *               turn, which would spend the person's plan, so we do not try
 *
 * What runs: `<cli> --version` (5 s), and for a CLI that has one, its own
 * status command (`codex login status`). Claude Code has no status command,
 * so its login is read from the account file Claude Code writes, the same
 * way the desktop's subscription step does. Never a completion. Nothing
 * from the CLI's output is printed back except a version number, so an API
 * key `codex login status` might echo never leaves this function.
 */

export type SubscriptionCliState = "missing" | "signed_out" | "ready" | "unknown";

export interface SubscriptionCliStatusReport {
  cli: SubscriptionCliName;
  productName: string;
  state: SubscriptionCliState;
  installed: boolean;
  /** `x.y.z` from `--version`, or null when it printed none. */
  version: string | null;
  /** true / false when known, null when it cannot be checked without a real turn. */
  signedIn: boolean | null;
  /** How the login was checked: the CLI's status command, its login file, or not at all. */
  loginCheck: "command" | "file" | "none";
  /** Codex signed in with an API key rather than ChatGPT: it bills per token. */
  apiKeyLogin?: boolean;
  /** The command that fixes it (install, or sign in), or null when ready. */
  fix: string | null;
  /** One plain sentence for a person. */
  message: string;
  /** Names (never values) of variables that move the CLI off the plan onto per-token billing. */
  billingEnvSet: string[];
}

export interface SubscriptionCliStatusDeps {
  binPath?: string;
  run?: CliRunner;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  cwd?: string;
  exists?: (path: string) => boolean;
  readText?: (path: string) => string | null;
}

/**
 * The configured `subscriptionCli.binPath` for one CLI: the entry named
 * `preferId` first (the one being edited), else the first entry for that
 * CLI. `providers status` and the terminal wizard both ask this, so they
 * check the same binary.
 */
export function configuredSubscriptionBinPath(
  providers: ReadonlyArray<{ id: string; subscriptionCli?: { cli: string; binPath?: string } }> | undefined,
  cli: SubscriptionCliName,
  preferId?: string | null,
): string | undefined {
  const list = (providers ?? []).filter((p) => p.subscriptionCli?.cli === cli && p.subscriptionCli.binPath);
  const pick = (preferId ? list.find((p) => p.id === preferId) : undefined) ?? list[0];
  return pick?.subscriptionCli?.binPath;
}

const VERSION_RE = /\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/;

/** The command a person runs to sign in. */
export function subscriptionLoginCommand(cli: SubscriptionCliName): string {
  return cli === "codex" ? "codex login" : "claude   (then /login)";
}

/** The install command for this platform, as the desktop's step shows it. */
export function subscriptionInstallCommand(cli: SubscriptionCliName, platform: NodeJS.Platform): string {
  if (cli === "claude") {
    return platform === "win32"
      ? "irm https://claude.ai/install.ps1 | iex"
      : "curl -fsSL https://claude.ai/install.sh | bash";
  }
  return "npm install -g @openai/codex";
}

function readJson(path: string, readText: (p: string) => string | null): Record<string, unknown> | null {
  const text = readText(path);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Claude Code's login, from its own files: `.credentials.json` in the config
 * folder (Linux, Windows), or the `oauthAccount` record in `.claude.json`
 * (every platform; on macOS the token itself is in the Keychain, which we do
 * not open). Mirrors desktop/main/subscription-cli-detect.ts.
 */
export function claudeSignedInFromFiles(d: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  exists: (path: string) => boolean;
  readText: (path: string) => string | null;
}): boolean | null {
  const path = d.platform === "win32" ? win32 : posix;
  const configDir = d.env.CLAUDE_CONFIG_DIR || path.join(d.home, ".claude");
  if (d.exists(path.join(configDir, ".credentials.json"))) return true;
  const stateFile = d.env.CLAUDE_CONFIG_DIR
    ? path.join(d.env.CLAUDE_CONFIG_DIR, ".claude.json")
    : path.join(d.home, ".claude.json");
  if (!d.exists(stateFile)) return false;
  const state = readJson(stateFile, d.readText);
  if (state === null) return null;
  const account = state.oauthAccount;
  return !!account && typeof account === "object";
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && /timed out/i.test(err.message);
}

export async function checkSubscriptionCli(
  adapter: CliAdapterDescriptor,
  deps: SubscriptionCliStatusDeps = {},
): Promise<SubscriptionCliStatusReport> {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const run = deps.run ?? runCliCommand;
  const timeoutMs = deps.timeoutMs ?? 5_000;
  const binary = resolveCliBinary(adapter.defaultBinary, deps.binPath, platform, env);
  const cli = adapter.cli;
  const product = adapter.productName;
  const billingEnvSet = adapter.billingEnvKeys.filter((k) => typeof env[k] === "string" && env[k] !== "");
  const base = { cli, productName: product, billingEnvSet };
  const runOpts = {
    binary,
    cwd: deps.cwd ?? tmpdir(),
    timeoutMs,
    maxOutputBytes: 64 * 1024,
    installHint: adapter.installHint,
    authHint: adapter.authHint,
    productName: product,
    stripEnv: adapter.billingEnvKeys,
  };

  let version: string | null = null;
  try {
    const out = await run({ ...runOpts, args: adapter.healthArgs() });
    version = VERSION_RE.exec(`${out.stdout}\n${out.stderr}`)?.[1] ?? null;
  } catch (err) {
    if (err instanceof SubscriptionCliNotInstalledError) {
      const fix = subscriptionInstallCommand(cli, platform);
      return {
        ...base, state: "missing", installed: false, version: null, signedIn: false, loginCheck: "none", fix,
        message: `${product} is not installed. Install it with: ${fix}`,
      };
    }
    // Present but `--version` failed or hung: something is there, and a
    // turn may still work. Not ours to call missing.
    return {
      ...base, state: "unknown", installed: true, version: null, signedIn: null, loginCheck: "none", fix: null,
      message: isTimeout(err)
        ? `${product} is installed but did not answer \`--version\` within ${Math.round(timeoutMs / 1000)}s. Can't verify the login.`
        : `${product} is installed but \`--version\` failed. Can't verify the login.`,
    };
  }

  const loginFix = subscriptionLoginCommand(cli);
  const statusArgs = adapter.authStatusArgs?.();
  if (statusArgs) {
    try {
      const out = await run({ ...runOpts, args: statusArgs });
      // `codex login status` says which login: "Logged in using ChatGPT", or
      // "... using an API key - sk-…". Only the kind is kept, never the text.
      const said = `${out.stdout}\n${out.stderr}`;
      if (/api key/i.test(said) && !/chatgpt/i.test(said)) {
        return {
          ...base, state: "signed_out", installed: true, version, signedIn: false, loginCheck: "command", apiKeyLogin: true, fix: loginFix,
          message: `${product} is signed in with an API key, which bills per token, not your plan. Sign in with ChatGPT: ${loginFix}`,
        };
      }
      return {
        ...base, state: "ready", installed: true, version, signedIn: true, loginCheck: "command", fix: null,
        message: `${product}${version ? ` ${version}` : ""} is installed and signed in.`,
      };
    } catch (err) {
      // Only a failure that reads as signed out ("Not logged in", the
      // mapper's SubscriptionCliAuthError) is signed_out. A hang, a crash,
      // a permission error or a signal says nothing about the login.
      if (err instanceof SubscriptionCliAuthError) {
        return {
          ...base, state: "signed_out", installed: true, version, signedIn: false, loginCheck: "command", fix: loginFix,
          message: `${product} is installed but not signed in. Sign in with: ${loginFix}`,
        };
      }
      return {
        ...base, state: "unknown", installed: true, version, signedIn: null, loginCheck: "none", fix: null,
        message: isTimeout(err)
          ? `${product} is installed, but its login check did not answer in time. Can't verify the login.`
          : `${product} is installed, but its login check failed. Can't verify the login.`,
      };
    }
  }

  if (cli === "claude") {
    const signedIn = claudeSignedInFromFiles({
      platform,
      env,
      home: deps.home ?? homedir(),
      exists: deps.exists ?? existsSync,
      readText: deps.readText ?? ((p) => { try { return readFileSync(p, "utf8"); } catch { return null; } }),
    });
    if (signedIn === true) {
      return {
        ...base, state: "ready", installed: true, version, signedIn: true, loginCheck: "file", fix: null,
        message: `${product}${version ? ` ${version}` : ""} is installed and its account file says you are signed in.`,
      };
    }
    if (signedIn === false) {
      return {
        ...base, state: "signed_out", installed: true, version, signedIn: false, loginCheck: "file", fix: loginFix,
        message: `${product} is installed but not signed in. Run \`claude\` and complete /login.`,
      };
    }
  }

  // Decided 12.11: no test turn to find out, it would spend the plan.
  return {
    ...base, state: "unknown", installed: true, version, signedIn: null, loginCheck: "none", fix: null,
    message: `${product}${version ? ` ${version}` : ""} is installed. Can't verify the login without spending your plan; if the first answer says you are signed out, run: ${loginFix}`,
  };
}
