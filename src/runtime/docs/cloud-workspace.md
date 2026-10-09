# Cloud session workspace

Status: current
Owner: src/runtime/

`session.workingDir` is the cloud environment boundary. [session-workspace.ts](../session-workspace.ts) prepares a per-step snapshot before budgeting and compaction. Prompt capabilities, project instructions, the skill catalog and skill dispatch use this snapshot. The first local-to-cloud fallback prepares it before the provider request, on both unary and streaming paths. No shared current-directory setter is involved.

`getSessionWorkspace(sessionOrId)` exposes the cloud view to interfaces; local sessions return null. Preview builds from the requested session without saving. TUI uses its selected session, sidecar `skill_list` uses its active session, and HTTP skills/capabilities accept optional `sessionId`. Calls without a session retain the legacy boot-workspace catalog.

Cloud Fusion parents pass their working directory into ephemeral session creation and result-file validation. Their local workers discover only Atomic project/global skills in that directory, retaining local catalog budgets. Independent local sessions keep their previous discovery and prompt behavior.

## Project instructions

[project-instructions.ts](../project-instructions.ts) loads root and nested `AGENTS.md`, `AGENT.md`, `CLAUDE.md`, and `.claude/CLAUDE.md` before the first action. Ancestors outside the session folder and other agents' home configuration are never searched. Every block identifies its source and scope. A `.claude/CLAUDE.md` applies to the directory containing `.claude`; deeper scopes refine ancestors. For conflicts within one scope, precedence is `AGENTS.md` > `AGENT.md` > `CLAUDE.md` > `.claude/CLAUDE.md`. Explicit user/system instructions retain priority. Files do not grant permissions.

Git discovery includes tracked and nonignored files; root names are checked directly, even if ignored. Outside Git, traversal excludes `.git` and `node_modules` and stops at 100,000 directory entries. Symlink files escaping the workspace are skipped with diagnostics; fallback traversal does not descend symlink directories. Git discovery has a five-second timeout and a 1 MiB result bound. Read errors on found instructions stop preparation, as do more than 512 instruction blocks or 1 MiB of instruction content. Missing optional instruction files are normal. Content is never silently clipped.

CLAUDE files expand `@path` imports relative to the importing file, including nested imports up to four hops. Imported blocks inherit the importing scope and priority. Cycles produce diagnostics; repeated paths in the same scope are loaded once. Fenced and inline code are ignored. External and home imports are skipped with diagnostics; a missing internal import is an error.

Updates and removals enter the existing cloud context journal. Unchanged bodies are not repeated, and mutable rules never enter the stable prefix. Compaction carries only active state; old messages remain historical evidence.

## Project skills

See [cloud skill discovery and controls](../../skills/docs/cloud-workspace.md). Loaded cloud bodies persist as `cloudLoadedSkills` in session JSON, with workspace, selected manifest path and content fingerprint; no SQL schema change is required. Runtime reconciles them against the current files and policy before budgeting. A changed body is reread; a removed, disabled or source-switched skill is deactivated. Source switches require another `skill.view`. Local `loadedSkills` are separate. Legacy records are checked against current discovery before use.

## Verification

[Instruction tests](../project-instructions.test.ts), [workspace skills tests](../../skills/workspace-skills.test.ts), and [execution seams](../../agent/cloud-workspace-seam.test.ts) cover discovery boundaries, live policy, concurrent sessions, fallback, preview, journaling, resume and compaction. Fusion delegate/factory tests cover inherited paths. These tests use fake models; they do not establish how reliably a real model follows conflicting natural-language rules.
