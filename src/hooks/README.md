# Hooks (PreToolUse / PostToolUse)

Status: draft
Owner: src/hooks/

User and plugin commands that run before and after a tool call, in the Claude Code `hooks.json` format. Read [AGENTS.md](AGENTS.md) before changing it.

## Where hooks come from

- `<stateDir>/hooks.json` (usually `~/.atomic-agent/hooks.json`): the user's own. Not part of `config.json`. Re-read when the file changes; no restart.
- Enabled plugins: `hooks/hooks.json` or inline `hooks` in `plugin.json` (see [../plugins/README.md](../plugins/README.md)). Loaded only when the plugin may run code (`pluginCodeAllowed`, set with `atomic-agent plugin allow-code <name>` and dropped on every plugin update); otherwise one diagnostic and nothing runs. `disabledParts` entry `hook:<Event>` switches one event off. `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}` are expanded.

```json
{
  "defaultTimeout": 60,
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "~/bin/check-shell.sh", "timeout": 10 }] }
    ],
    "PostToolUse": [
      { "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "npx prettier --write \"$(jq -r .tool_input.file_path)\"" }] }
    ]
  }
}
```

`timeout` and `defaultTimeout` are seconds (default 60, max 600). A hook past its timeout is killed with its process group and logged; the call is not blocked by it.

## Matching

`matcher` is a regular expression tested against the whole tool name (empty or `*` = every tool). It is tested against our name (`os.shell.run`) and the Claude name from [hook-matcher.ts](hook-matcher.ts): `Bash`, `Read`, `Write`, `Edit` (also `os.fs.patch`), `MultiEdit`, `Glob`, `Grep`, `LS`, `WebFetch`, `WebSearch`, `Task` (`fusion.delegate`), and `mcp__<server>__<tool>` for `mcp.<server>.<tool>`.

`Bash` matches only `os.shell.run`. The built-in git tools (`os.git.*`) have no Claude name, so a `Bash` hook does not see them. A hook that should see git calls too needs its own matcher: `Bash|os\.git\..*`, written in `hooks.json` as `"matcher": "Bash|os\\.git\\..*"`.

## Input and decisions

stdin is JSON: `session_id`, `cwd`, `hook_event_name`, `tool_name` (Claude name when there is one), `atomic_tool_name`, `claude_tool_name`, `tool_input` (our arguments plus `file_path`, `command`, `old_string`, `new_string`), and for PostToolUse `tool_response` (`status`, `output`, `truncated`).

- Exit 2: PreToolUse refuses the call with stderr as the reason; PostToolUse sends stderr to the model with the result.
- Exit 0 with JSON: `hookSpecificOutput.permissionDecision` `deny` / `ask` / `allow` (+ `permissionDecisionReason`), else `decision: "block"` / `"approve"` + `reason`; `continue: false` + `stopReason` refuses; PostToolUse `additionalContext` is added to the result.
- Other exits, timeouts, bad JSON: logged, attached as `details.hookErrors`, never blocking.
- `ask` opens the normal approval prompt (category `hook_ask`, never granted for the session or sent to smart review); a denial reads as the user's. `allow` does not skip the tool's own approval: hooks only tighten.

Matching hooks of one event run in parallel; deny beats ask beats allow.

## Entry points

- [hook-engine.ts](hook-engine.ts): `ToolHookEngine`, `runWithToolHooks`, stdin shape; installed at boot in `runtime/bootstrap.ts`.
- [hook-config.ts](hook-config.ts): parse and load user and plugin hooks.
- [hook-runner.ts](hook-runner.ts): spawn with timeout, filtered env (`sandbox/command-env.ts`, no provider keys).
- [hook-output.ts](hook-output.ts): exit code and stdout JSON to a verdict.
- Wired in `agent/dispatch/batch-scheduler.ts` (`invokeWithHooks`), around the registry call and inside the approval ledger. Terminal calls (reply, finish) run no hooks.

## Not done yet

SessionStart, Stop, UserPromptSubmit and the other Claude events parse but are not fired. No UI or CLI for hooks. Hooks also run for Fusion worker calls, which go through the same executor.

## Validation

`npx vitest run src/hooks src/agent/dispatch`; `npm run lint`; `npm run docs:check`.
