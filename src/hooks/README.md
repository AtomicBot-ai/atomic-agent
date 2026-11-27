# Hooks

Status: draft
Owner: src/hooks/

User and plugin commands that run before and after a tool call and on session events (SessionStart, UserPromptSubmit, Stop, PreCompact, SessionEnd, SubagentStop, FileChanged, PermissionRequest, Notification), in the Claude Code `hooks.json` format. Read [AGENTS.md](AGENTS.md) before changing it.

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

## Session events

Same files, runner, timeouts and environment as the tool hooks ([session-hook-engine.ts](session-hook-engine.ts), [session-hook-output.ts](session-hook-output.ts)). stdin always has `session_id`, `cwd`, `hook_event_name`, `permission_mode`, `transcript_path: null`.

| Event | When | Matcher tested against | Extra stdin | What it can do |
|---|---|---|---|---|
| `SessionStart` | before the first turn this process runs for a session | `source`: `startup` (no earlier turn) or `resume` | `source` | stdout / `additionalContext` is context for every turn of the session |
| `UserPromptSubmit` | before every turn, before anything is saved | ignored | `prompt` | exit 2, `decision: "block"` or `continue: false` refuses the message (`HookBlockedPromptError`, nothing saved); stdout / `additionalContext` is context |
| `Stop` | after a turn the model ended with a reply or finish | ignored | `stop_hook_active`, `last_assistant_message` | after a reply, exit 2 or `decision: "block"` + `reason` sends the agent back to work with the reason as its next message, at most 3 times per turn |
| `PreCompact` | before a compaction builds its checkpoint | `trigger`: `manual` or `auto` | `trigger`, `custom_instructions` | observes only; exit 2 is logged |
| `SessionEnd` | once per session this process started: the model called `finish`, the chat was deleted, or the agent is quitting | `reason` (`other`, `clear`, `prompt_input_exit`) or `atomic_reason` (`finished`, `deleted`, `shutdown`) | `reason`, `atomic_reason` | observes only; at quit the agent waits at most 1.5 s for them |
| `SubagentStop` | after a subagent's or Fusion worker's turn, before its answer goes up | `agent_type`: `subagent` or `fusion-worker` | `session_id` (the parent's), `agent_id` (the worker's session), `agent_type`, `stop_hook_active`, `last_assistant_message`, `agent_transcript_path: null` | exit 2 or `decision: "block"` + `reason` sends the worker back to work, at most 3 times |
| `FileChanged` | a file in a session's folder was added, changed or removed (any writer, the agent too), 300 ms after the last event on it | the file name, or its path in the folder (`src/app.ts`) | `file_path`, `event` (`add` / `change` / `unlink`), `atomic_relative_path` | observes only |
| `PermissionRequest` | a person is about to be asked to approve a call (not for `ask_user` or a browser hand-over) | the tool, as for PreToolUse | `tool_name`, `atomic_tool_name`, `claude_tool_name`, `tool_input`, `permission_suggestions: []`, `atomic_category`, `atomic_reason` | exit 2, `hookSpecificOutput.decision.behavior: "deny"` (+ `message`), `permissionDecision: "deny"` or `decision: "block"` refuses without asking; `allow` is ignored |
| `Notification` | the approval or question prompt just went out | `notification_type`: `permission_prompt` or `elicitation_dialog` (`ask_user`, browser hand-over) | `message`, `title`, `notification_type`, `atomic_tool_name`, `atomic_category` | observes only, does not delay the prompt; for a desktop or phone ping while the agent waits |

SessionEnd fires for sessions that ran a turn in this process only; `reason` uses Claude Code's words so its scripts work. FileChanged watches a session's folder from its first turn while a FileChanged hook is configured (checked every turn), one chokidar watcher per folder ([file-changed-watcher.ts](file-changed-watcher.ts)): three levels deep, without `.git`, `node_modules`, `.atomic-agent`, build output and virtualenvs; only the top level of the home folder or a drive root. It closes when the folder's last session ends. PermissionRequest and Notification ([permission-hooks.ts](permission-hooks.ts)) run from `ApprovalGate.setPromptHooks`, only past every level, grant, rule and reviewer, so a request nobody would be asked about never fires them, and a Fusion worker (refuse policy) never does. `tool_input` is the call's arguments when the tool asked from inside `runWithToolHooks`, else what the request carries (`command`, `file_path`, `preview`). A PermissionRequest refusal reads `Blocked by a PermissionRequest hook: <reason>` and counts as automatic, not as the user's no.

SessionStart output is kept for the session in this process and shown on every turn as `### hook-session-start` (`RunTurnOptions.sessionHookContext`), so the cloud journal keeps one entry and never retracts it; a new process fires SessionStart again with `resume` and replaces it. UserPromptSubmit output is `### hook-context` on every step of that one turn only (`RunTurnOptions.hookContext`). Both sit after the conversation, so the stable prefix does not move. Stop does not run after a cancel, a failure or a ceiling stop (nor does SubagentStop), and SessionStart, UserPromptSubmit, Stop and SessionEnd never run for Fusion worker or subagent turns: those get SubagentStop. They never touch approval: a continuation's tool calls go through the same gate.

Wired in `runtime/composition/runtime-session-hooks.ts` (called from `executeTurn`, so `runTurn` and the sidecar both get them; `subagentStopHooks` for the worker branch), `runtime/context-compaction-runner.ts` (`beforeCompact`), `runtime-session-services.ts` (delete), `runtime-lifecycle.ts` (quit) and the approval gate; the engine is built in `runtime/bootstrap.ts` and passed explicitly.

## Entry points

- [hook-engine.ts](hook-engine.ts): `ToolHookEngine`, `runWithToolHooks`, stdin shape; installed at boot in `runtime/bootstrap.ts`.
- [hook-config.ts](hook-config.ts): parse and load user and plugin hooks.
- [hook-runner.ts](hook-runner.ts): spawn with timeout, filtered env (`sandbox/command-env.ts`, no provider keys).
- [hook-output.ts](hook-output.ts): exit code and stdout JSON to a verdict.
- Wired in `agent/dispatch/batch-scheduler.ts` (`invokeWithHooks`), around the registry call and inside the approval ledger. Terminal calls (reply, finish) run no hooks.

## Not done yet

Every event in `KNOWN_HOOK_EVENTS` fires. Not here: Claude Code's `TaskCompleted`, the `idle_prompt` notification (60 s waiting for input) and a PermissionRequest `allow` or `updatedInput`, which would loosen approval. No UI or CLI for hooks. Hooks also run for Fusion worker calls, which go through the same executor.

## Validation

`npx vitest run src/hooks src/agent/dispatch`; `npm run lint`; `npm run docs:check`.
