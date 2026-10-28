# Command execution

Status: current
Owner: src/sandbox/

Owns command jobs, output caps and process-tree cancellation. Preserve shell interpretation and explicit cancellation; dispatch approval lives in the caller wrapper.

Entry point: [command-runner.ts](command-runner.ts).

[command-env.ts](command-env.ts) builds the environment of an agent-run command: the agent's own environment minus secret-looking variables (names with KEY, TOKEN, SECRET, PASSWORD and similar, plus a list of known provider keys), with an explicit passthrough list (ATO-347). It is a deny filter rather than the MCP allowlist because a shell command needs the user's full toolchain environment. `os.shell.run` and `os.git.*` use it; the runner itself keeps inheriting `process.env` for internal callers (subscription CLIs, `gh auth token`) that need the keys. Read the root instruction route and the underlying domain instructions before cross-domain changes.

[command-toolchain-env.ts](command-toolchain-env.ts) adds, for `os.shell.run` only and after the filter, fixed non-interactive switches and the user's toolchain PATH (login shell, Homebrew, nvm, pyenv and similar folders that exist), appended after the inherited PATH so nothing already found is shadowed (ATO-1252). It reads no variable back from the agent's environment except PATH.

Checks: `npx vitest run src/sandbox` when tests are present; `npm run lint`; `npm run docs:check`.
