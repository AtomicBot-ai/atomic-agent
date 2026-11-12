# Subagent profiles

Status: current
Owner: src/agent-profiles/

A subagent profile is a named role a Fusion task can be handed to (ATO-566): `fusion.delegate { tasks: [{ id, instructions, profile: "review" }] }`. The worker then gets the profile's instructions in its brief, the profile's tool allowlist, and the profile's model when the task named none.

## Format

Markdown with YAML frontmatter, the format of Claude Code's `.claude/agents/*.md` (also Goose and pi): `name` (defaults to the file name; lower-cased; letters, digits, `-`, `_`), `description`, `model`, `tools` (a list or one comma-separated string). The body is the instructions. Other keys are ignored. Limits: 64 KiB per file, 16,000 chars of body. A broken file is a diagnostic in the operator log, never a failed turn ([agent-profile.ts](agent-profile.ts)).

`model`: a fusion role (`plan`, `build`, `review`, `explore`, `utility`) runs the task on that role's model from `llm.runMode.fusion.roles`; a model name or provider id on the allowed list runs it there; `inherit` or any other name (`sonnet` in a file written for Claude Code) leaves the task on its usual model with a note in `details.profiles`. A task's own `model` or `role` always wins.

`tools`: our names (`os.fs.read`), prefixes (`verify.*`, `mcp.github.*`) or Claude Code names (`Read`, `Grep`, `Glob`, `Bash`, `Edit`, `Write`, `WebFetch`, `WebSearch`, `mcp__server__tool`) ([profile-tools.ts](profile-tools.ts)). The list only narrows: it is ANDed with the worker policy, so it never brings back `fusion.delegate`, memory writes or the screen. `reply`, `tool.view` and `tool.search` always stay. A list where no entry is known is dropped with a note, and the worker keeps its usual tools.

## Sources and order

[profile-loader.ts](profile-loader.ts), first match of a name wins: the user's `<stateDir>/agents/*.md`, then the project's `.atomic-agent/agents/*.md` and `.claude/agents/*.md`, then enabled plugins' `agents/*.md` (named `plugin:agent`), then the built-ins. Profiles are reread on every fan-out.

Project files follow [project folder trust](../skills/docs/project-trust.md): each file is an item of the folder's trust question, by its workspace-relative path like an instruction file, and is not read until the operator trusted it. A profile folder that resolves outside the workspace is not read.

## Built-ins

[builtin-profiles.ts](builtin-profiles.ts): `explore` (find code, role `explore`), `review` (find bugs, role `review`, keeps `verify.*`), `research` (web and local files, role `explore`). All three are read-only: no writes, no shell, no browser clicks or typing. A user or project file of the same name replaces one.

## Wiring

`src/tools/fusion/task-profiles.ts` applies profiles to a fan-out's tasks; `worker-prompt.ts` quotes the instructions; `worker-tool-policy.ts` `workerToolFilterFor` builds the turn's tool filter. The runtime passes `resolveAgentProfiles` in `src/runtime/composition/runtime-tool-catalog.ts`. Profiles exist only in Fusion: an ordinary turn has no subagent tool to name one with.

## Validation

`npx vitest run src/agent-profiles src/tools/fusion/task-profiles.test.ts src/runtime/project-trust.test.ts`.
