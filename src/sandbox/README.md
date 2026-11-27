# Command execution

Status: current
Owner: src/sandbox/

Owns command jobs, output caps and process-tree cancellation. Preserve shell interpretation and explicit cancellation; dispatch approval lives in the caller wrapper.

Entry point: [command-runner.ts](command-runner.ts).

[command-env.ts](command-env.ts) builds the environment of an agent-run command: the agent's own environment minus secret-looking variables (names with KEY, TOKEN, SECRET, PASSWORD and similar, plus a list of known provider keys), with an explicit passthrough list (ATO-347). It is a deny filter rather than the MCP allowlist because a shell command needs the user's full toolchain environment. `os.shell.run`, `os.git.*`, hooks and skill scripts call it with the configured passthrough. It is also the default of `runCommand` and `startCommandJob` (ATO-175): a caller that passes no `env` (ripgrep, trash, process list/kill, curl, window scripts, capability probes) gets the filtered environment, never the raw `process.env`. A child that really needs a key gets an `env` built and passed explicitly by its caller: the subscription CLIs (`cli-child-env.ts`) and `gh auth token` do this. Read the root instruction route and the underlying domain instructions before cross-domain changes.

[command-toolchain-env.ts](command-toolchain-env.ts) adds, for `os.shell.run` only and after the filter, fixed non-interactive switches and the user's toolchain PATH (macOS `/etc/paths`, Homebrew, nvm, pyenv and similar folders that exist; never the login shell, whose rc files the agent can write), appended after the inherited PATH so nothing already found is shadowed (ATO-1252). It reads no variable back from the agent's environment except PATH.

[os-sandbox.ts](os-sandbox.ts) is Safe Mode's OS sandbox for `os.shell.run` (ATO-469, network switch ATO-472). Off by default; `ATOMIC_AGENT_SANDBOX=workspace` turns it on. The command is wrapped before spawn: macOS `sandbox-exec` with a Seatbelt profile built per call (paths passed as `-D` parameters, never spliced into the profile), Linux `bwrap`. Writes are allowed only under the session's working directory, temp and a fixed list of pure download caches (never a tool's `bin`, `init.d` or settings); the model's `cwd` argument never widens this. Credential folders and files (`~/.ssh`, `~/.aws`, `~/.netrc`, shell history, ...) and the agent's state directory cannot be read, under their link path and their resolved path; a working folder inside one is reopened by itself, the rest stays hidden. Without network (`ATOMIC_AGENT_SANDBOX_NETWORK` not `on`) outbound IP and local-socket connections, DNS lookups and URL opening are blocked; loopback IP stays open. Where no sandbox exists (Windows, Linux without `bwrap`) a command is refused with a message that says how to turn the mode off, never run unsandboxed. Not yet wrapped: skill scripts, git plumbing, hooks.

[secret-placeholders.ts](secret-placeholders.ts) reads and fills `{{secret:NAME}}` in a command (ATO-476); a malformed placeholder or a missing name is an error, and a line a shell parses takes only plain token characters from a value. [resolved-secret-values.ts](resolved-secret-values.ts) holds, in memory only, every value resolved from a secret reference, with its base64, base64url and URL-encoded forms; the secret detector masks them on every call whatever list its caller passes, and [capped-output.ts](capped-output.ts) hides a piece of one left on either side of its dropped middle.

Checks: `npx vitest run src/sandbox` when tests are present; `npm run lint`; `npm run docs:check`.
