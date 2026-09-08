/**
 * How the agent's GitHub token reaches `git push`.
 *
 * Git does not read `GITHUB_TOKEN`. The usual answers are a credential
 * helper (writes to the operator's global git config, or to a keychain
 * they did not ask us to touch) or a token embedded in the remote URL
 * (ends up in `.git/config` and in every error message). Neither is
 * acceptable for a token the operator handed *this* process.
 *
 * The third way is a per-process `http.<url>.extraheader` config, the
 * mechanism GitHub's own tooling uses: the credential is scoped to
 * `https://github.com/`, so git will not attach it to any other host —
 * a repo can have several remotes — and basic auth with the literal
 * username `x-access-token` is the form GitHub documents for tokens.
 *
 * It travels as *environment*, not argv: `GIT_CONFIG_COUNT` /
 * `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` (git ≥ 2.31) inject the
 * config for that one process, where a `-c` flag would sit in the
 * command line for every other user on the machine to read from `ps`
 * for the whole push.
 */
export const GITHUB_EXTRAHEADER_KEY = "http.https://github.com/.extraheader";

export function githubAuthHeaderValue(token: string): string {
  const basic = Buffer.from(`x-access-token:${token}`, "utf8").toString(
    "base64",
  );
  return `AUTHORIZATION: basic ${basic}`;
}

export function githubAuthGitEnv(token: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: GITHUB_EXTRAHEADER_KEY,
    GIT_CONFIG_VALUE_0: githubAuthHeaderValue(token),
  };
}
