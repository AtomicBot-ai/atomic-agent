# Cloud session workspace

Status: current
Owner: src/runtime/

`session.workingDir` is the cloud environment boundary. [session-workspace.ts](../session-workspace.ts) prepares a per-step snapshot before budgeting and compaction. Prompt capabilities, project instructions, the skill catalog and skill dispatch use this snapshot. The first local-to-cloud fallback prepares it before the provider request, on both unary and streaming paths. No shared current-directory setter is involved.

`getSessionWorkspace(sessionOrId)` exposes the cloud view to interfaces; local sessions return null. Preview builds from the requested session without saving. TUI uses its selected session, sidecar `skill_list` uses its active session, and HTTP skills/capabilities accept optional `sessionId`. Calls without a session retain the legacy boot-workspace catalog.

Cloud Fusion parents pass their working directory into ephemeral session creation and result-file validation. Their local workers discover only Atomic project/global skills in that directory, retaining local catalog budgets. Independent local sessions keep their previous discovery and prompt behavior.

## Project instructions

[project-instructions.ts](../project-instructions.ts) loads root `AGENTS.md`, `AGENT.md`, `CLAUDE.md`, and `.claude/CLAUDE.md` before the first action, plus nested copies inside a Git repository. Ancestors outside the session folder and other agents' home configuration are never searched. Every block identifies its source and scope. A `.claude/CLAUDE.md` applies to the directory containing `.claude`; deeper scopes refine ancestors. For conflicts within one scope, precedence is `AGENTS.md` > `AGENT.md` > `CLAUDE.md` > `.claude/CLAUDE.md`. Explicit user/system instructions retain priority. Files do not grant permissions.

Nested discovery uses Git only: tracked and nonignored files, skipping `.git` and `node_modules`; root names are checked directly, even if ignored. Outside Git, or when Git refuses the folder or times out, only the root files load and nothing below the root is listed. The home directory, any ancestor of it, and any folder in a repository rooted at home (a dotfiles repository) are always root-only, so launching from `~` never reads unrelated projects or opens privacy-protected folders. Symlink files escaping the workspace are skipped. Git discovery has a five-second timeout and a 1 MiB result bound.

Instruction problems never fail a step: an unreadable, special, binary or oversized (over 1 MiB) file is skipped. The total budget is 48 KiB and 64 files, and when the active model's context window is known it shrinks so instructions take at most 10% of the window (estimated at three bytes per token). Budgets keep the shallowest and highest-priority files (root files and their imports first) and drop the deepest scopes first; a root file that does not fit keeps its beginning with a visible truncation marker. Cancellation is the only error that leaves preparation. Every skip, cut or truncation leaves a diagnostic with workspace-relative paths; repeated diagnostics are grouped. Missing optional instruction files are normal. Content is never silently clipped.

The runtime workspace loader caches discovery per workspace and budget. A cached result is reused while every file it looked at (the root, root names, discovered files and imports, present or missing) keeps its modification time and size, and for at most 30 seconds; after that discovery runs again, so a new nested file appears within that interval.

CLAUDE files expand `@path` imports relative to the importing file, including nested imports up to four hops. Imported blocks inherit the importing scope and priority. Cycles produce diagnostics; repeated paths in the same scope are loaded once. Fenced, indented and inline code are ignored. External, home, missing and non-file imports, imports deeper than four hops, imports Git ignores (or cannot classify; one batched `git check-ignore` per discovery) and secret-looking files (`.env*`, `.npmrc`, `.netrc`, `.pgpass`, `.pypirc`, `.git-credentials`, `credentials.json`, anything under `.aws/`, `.docker/config.json`, `id_rsa*` and similar keys, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.tfvars`, `*.kdbx`) are skipped with diagnostics. `@name` in prose is often a mention or a package scope rather than an import.

Updates and removals enter the existing cloud context journal. Unchanged bodies are not repeated, and mutable rules never enter the stable prefix. Compaction carries only active state; old messages remain historical evidence.

## Project skills

See [cloud skill discovery and controls](../../skills/docs/cloud-workspace.md). Loaded cloud bodies persist as `cloudLoadedSkills` in session JSON, with workspace, selected manifest path and content fingerprint; no SQL schema change is required. Runtime reconciles them against the current files and policy before budgeting. A changed body is reread; a removed, disabled or source-switched skill is deactivated. Source switches require another `skill.view`. Local `loadedSkills` are separate. Legacy records are checked against current discovery before use.

## Verification

[Instruction tests](../project-instructions.test.ts), [workspace skills tests](../../skills/workspace-skills.test.ts), and [execution seams](../../agent/cloud-workspace-seam.test.ts) cover discovery boundaries, live policy, concurrent sessions, fallback, preview, journaling, resume and compaction. Fusion delegate/factory tests cover inherited paths. These tests use fake models; they do not establish how reliably a real model follows conflicting natural-language rules.
