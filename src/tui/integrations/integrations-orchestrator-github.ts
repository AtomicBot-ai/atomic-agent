/**
 * The GitHub verbs of the Integrations hub — `verify` and `import` —
 * as functions over injectable deps, so the orchestrator stays the one
 * module that writes credentials and this one never touches storage.
 */

import {
  GithubApi,
  looksLikeGithubToken,
  resolveGithubToken,
  scrubGithubToken,
} from "../../github/index.js";
import { runCommand } from "../../sandbox/command-runner.js";

/** Seams for the GitHub verbs, so tests never reach the network or `gh`. */
export interface GithubHubDeps {
  /** Build the client the `verify` action asks "who am I". */
  apiFactory?: (token: string) => Pick<GithubApi, "whoami">;
  /**
   * Read the token `gh auth login` stored, or `null` when `gh` is
   * missing or logged out. Production runs `gh auth token`.
   */
  readGhCliToken?: () => Promise<string | null>;
}

export interface GithubVerifyOutcome {
  /** `@login · scopes` on success, `null` on failure. */
  identity: string | null;
  /** The scrubbed refusal on failure, `null` on success. */
  error: string | null;
  message: string;
}

/**
 * Ask GitHub who the saved token belongs to. Never throws: the outcome
 * is data the hub stores as the row's status until the token changes.
 */
export async function verifyGithubToken(
  deps: GithubHubDeps,
): Promise<GithubVerifyOutcome> {
  const token = resolveGithubToken();
  if (!token) {
    return { identity: null, error: "no GitHub token saved", message: "" };
  }
  const factory =
    deps.apiFactory ?? ((t: string) => new GithubApi({ token: t }));
  try {
    const me = await factory(token).whoami();
    const scopes = me.scopes.length > 0 ? ` · ${me.scopes.join(", ")}` : "";
    return {
      identity: `@${me.login}${scopes}`,
      error: null,
      message: `GitHub token works — connected as @${me.login}`,
    };
  } catch (err) {
    const message = scrubGithubToken(
      err instanceof Error ? err.message : String(err),
    );
    return { identity: null, error: message, message };
  }
}

/**
 * The token `gh auth login` stored, validated. Throws with the fix in
 * the message when there is nothing to import.
 */
export async function importGithubTokenFromGh(
  deps: GithubHubDeps,
): Promise<string> {
  const read = deps.readGhCliToken ?? readGhCliToken;
  const token = await read();
  if (!token) {
    throw new Error(
      "gh has no token to import — run `gh auth login` in a terminal first, or paste a token with e",
    );
  }
  if (!looksLikeGithubToken(token)) {
    throw new Error("gh returned something that is not a GitHub token");
  }
  return token;
}

/**
 * `gh auth token` prints the stored token for the active account and
 * exits non-zero when nobody is logged in. A missing `gh` binary is the
 * same outcome for the operator — nothing to import.
 *
 * `GH_TOKEN` / `GITHUB_TOKEN` are stripped from the child's env: `gh`
 * prefers them over its own keyring, so with a stale token already in
 * the hub the import would silently hand back that same token.
 */
export async function readGhCliToken(): Promise<string | null> {
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  try {
    const res = await runCommand("gh", ["auth", "token"], {
      cwd: process.cwd(),
      env,
      timeoutMs: 10_000,
    });
    if (res.exitCode !== 0) return null;
    const token = res.stdout.trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}
