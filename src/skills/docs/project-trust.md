# Project folder trust

Status: current
Owner: src/skills/

A cloned repository can ship skills (`.atomic-agent/skills`, `.agents/skills`, `.claude/skills`, `.cursor/skills`, `.pi/skills`) and instruction files (`AGENTS.md`, `CLAUDE.md` and the other names in the [runtime workspace contract](../../runtime/docs/cloud-workspace.md)). Nobody approved them, so they stay unloaded until the operator trusts the folder. Global skills in the state directory are not covered and always load.

## Rule

- An item is a project skill name or a workspace-relative instruction path. Each one is trusted, declined or pending. Only trusted items load: a pending or declined skill is absent from the model catalog, `skill.view` and `skill.run_script`, and an instruction file is never read. A trusted file that imports a withheld instruction file does not load it either.
- Answers live in user config as `skills.projectTrust`, keyed by the folder's native real path, so a symlink alias, `..` or another letter case on a case-insensitive volume shares one record. Nothing is written into the repository.
- The question is asked once per set of pending items, with counts: "This folder has 3 project skills and AGENTS.md. Trust them?". Yes trusts exactly the items shown; No declines them and is remembered. Editing a trusted skill or file does not ask again. A new skill name or a new instruction file is pending until it is answered, while the earlier answers stay.
- Nothing asks without a window. `run`, `serve` without a client that answers, Telegram/Discord channels and background tasks load no pending item and write an operator log line with the command that trusts the folder. That hint is never put into the model's context, so the model is not invited to trust the folder itself.

Known trade-off of the soft rule: trust is by name, not content. Replacing a trusted skill's body, or renaming another skill to a trusted name, is treated as an edit and loads without a new question. The same holds for a trusted instruction file that starts importing a file nobody listed.

## Commands

```sh
atomic-agent skill list                         # project skills show untrusted/declined, with the command to trust
atomic-agent skill list --workspace /path/repo  # also counts instruction files
atomic-agent skill project on --workspace /path/repo   # trust everything the folder ships now
atomic-agent skill project off --workspace /path/repo  # revoke: decline everything and switch project skills off
```

## HTTP

`GET /api/project-trust` (optional `?workingDir=<absolute path>` or `?sessionId=<id>`, otherwise the folder `serve` started in) returns `{ workingDir, pending, trusted, declined, questionId, question, hasEarlierAnswer, hint }`, where each list is `{ skills, instructions }`. `question` and `questionId` are null when nothing is pending.

`POST /api/project-trust` with `{ answer: "trust" | "decline", questionId, workingDir? | sessionId? }` records the answer for exactly the pending items of that question, refreshes the local skill catalog and returns the new status. When the folder changed since the question was read, it answers `409` with `error.code: "question_changed"` and the fresh `status`, and records nothing. Cloud sessions reread the answer on their next step.

`POST /api/project-trust` with `{ answer, scope: "all" }` (no `questionId`) is the settings switch for a past choice: it trusts or declines everything the folder ships now, like `skill project on|off --workspace`.

## Code

[project-trust.ts](../project-trust.ts) holds the lookup and the local registry gate, [workspace-skills.ts](../workspace-skills.ts) marks pending and declined project skills, [project instructions](../../runtime/project-instructions.ts) take an `allow` filter, and [runtime project-trust.ts](../../runtime/project-trust.ts) builds the question and records answers through [policy commands](../../config/skill-policy-commands.ts).
