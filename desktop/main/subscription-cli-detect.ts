import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter as hostDelimiter, posix, win32 } from "node:path";

/**
 * ATO-756: is the Claude Code / Codex CLI on this computer, and is it signed
 * in? Asked by the "Use my Claude / ChatGPT subscription" step, so it can say
 * what is missing in plain steps instead of saving an entry whose first turn
 * fails.
 *
 * Read-only, and it never runs the CLI: the person has not approved running
 * anything yet, and `claude` / `codex` with no arguments would open a session.
 * Installed is a file on PATH or in an install folder the vendors use; signed
 * in is the CLI's own login file. Only yes / no / unknown comes back, never a
 * token, an e-mail or the file's contents, and nothing here is logged.
 */

export type SubscriptionCli = "claude" | "codex";

export interface SubscriptionCliStatus {
  cli: SubscriptionCli;
  installed: boolean;
  /**
   * The binary found in a vendor install folder that is NOT on PATH, to save
   * as the entry's `subscriptionCli.binPath`. An app opened from the Dock gets
   * a short PATH, so a CLI the person runs fine in Terminal is "not installed"
   * to the agent. null when PATH finds it (nothing to pin) or nothing was found.
   */
  binPath: string | null;
  /** true / false from the login file; null when the CLI keeps it where we cannot tell. */
  signedIn: boolean | null;
  /** Codex signed in with an API key, not ChatGPT: it bills per token. */
  apiKeyLogin?: boolean;
}

export interface DetectDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  exists: (path: string) => boolean;
  readText: (path: string) => string | null;
}

function defaultDeps(): DetectDeps {
  return {
    platform: process.platform,
    env: process.env,
    home: homedir(),
    exists: existsSync,
    readText: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
  };
}

/** Folders the vendor installers and package managers put the CLI in, beyond PATH. */
function installDirs(cli: SubscriptionCli, d: DetectDeps): string[] {
  const path = d.platform === "win32" ? win32 : posix;
  const home = d.home;
  if (d.platform === "win32") {
    const appData = d.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    return [path.join(home, ".local", "bin"), path.join(appData, "npm")];
  }
  return [
    path.join(home, ".local", "bin"),
    ...(cli === "claude" ? [path.join(home, ".claude", "local")] : []),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".volta", "bin"),
  ];
}

function findIn(dirs: readonly string[], cli: SubscriptionCli, d: DetectDeps): string | null {
  const path = d.platform === "win32" ? win32 : posix;
  const suffixes = d.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const suffix of suffixes) {
      const candidate = path.join(dir, cli + suffix);
      if (d.exists(candidate)) return candidate;
    }
  }
  return null;
}

function readJson(path: string, d: DetectDeps): Record<string, unknown> | null {
  const text = d.readText(path);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Claude Code: `.credentials.json` in its config folder (Linux, Windows), or
 * the `oauthAccount` record in `~/.claude.json` (every platform; on macOS the
 * token itself is in the Keychain, which we do not open).
 */
function claudeSignedIn(d: DetectDeps): boolean | null {
  const path = d.platform === "win32" ? win32 : posix;
  const configDir = d.env.CLAUDE_CONFIG_DIR || path.join(d.home, ".claude");
  if (d.exists(path.join(configDir, ".credentials.json"))) return true;
  const stateFile = d.env.CLAUDE_CONFIG_DIR
    ? path.join(d.env.CLAUDE_CONFIG_DIR, ".claude.json")
    : path.join(d.home, ".claude.json");
  if (!d.exists(stateFile)) return false;
  const state = readJson(stateFile, d);
  if (state === null) return null;
  const account = state.oauthAccount;
  return !!account && typeof account === "object";
}

/** Codex: `auth.json` under CODEX_HOME (default ~/.codex); `tokens` is a ChatGPT login. */
function codexSignedIn(d: DetectDeps): { signedIn: boolean | null; apiKeyLogin?: boolean } {
  const path = d.platform === "win32" ? win32 : posix;
  const authFile = path.join(d.env.CODEX_HOME || path.join(d.home, ".codex"), "auth.json");
  if (!d.exists(authFile)) return { signedIn: false };
  const auth = readJson(authFile, d);
  if (auth === null) return { signedIn: null };
  if (auth.tokens && typeof auth.tokens === "object") return { signedIn: true };
  const key = auth.OPENAI_API_KEY;
  if (typeof key === "string" && key.length > 0) return { signedIn: false, apiKeyLogin: true };
  return { signedIn: false };
}

export function detectSubscriptionCli(
  cli: SubscriptionCli,
  deps: Partial<DetectDeps> = {},
): SubscriptionCliStatus {
  const d = { ...defaultDeps(), ...deps };
  const delimiter = d.platform === "win32" ? ";" : deps.platform ? ":" : hostDelimiter;
  const onPath = findIn((d.env.PATH ?? d.env.Path ?? "").split(delimiter), cli, d);
  const offPath = onPath ? null : findIn(installDirs(cli, d), cli, d);
  const installed = onPath !== null || offPath !== null;
  const login = cli === "claude" ? { signedIn: claudeSignedIn(d) } : codexSignedIn(d);
  return { cli, installed, binPath: offPath, ...login };
}

export function isSubscriptionCli(value: unknown): value is SubscriptionCli {
  return value === "claude" || value === "codex";
}
