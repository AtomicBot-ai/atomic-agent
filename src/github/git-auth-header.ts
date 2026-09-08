/**
 * How the agent's GitHub token reaches `git push`.
 *
 * Git does not read `GITHUB_TOKEN`. The usual answers are a credential
 * helper (writes to the operator's global git config, or to a keychain
 * they did not ask us to touch) or a token embedded in the remote URL
 * (ends up in `.git/config` and in every error message). Neither is
 * acceptable for a token the operator handed *this* process.
 *
 * The third way is what GitHub's own `actions/checkout` does: a
 * per-invocation `http.<url>.extraheader` config passed with `-c`, so
 * the credential lives only in the argv of the one git process that
 * needs it and is scoped to `https://github.com/` — git will not attach
 * it to any other host, which matters because a repo can have several
 * remotes. Basic auth with the literal username `x-access-token` is the
 * form GitHub documents for tokens.
 */
export function githubAuthGitArgs(token: string): string[] {
  const basic = Buffer.from(`x-access-token:${token}`, "utf8").toString(
    "base64",
  );
  return [
    "-c",
    `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`,
  ];
}
