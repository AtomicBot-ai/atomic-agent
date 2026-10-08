# Cloud project skills

Status: current
Owner: src/skills/

Cloud discovery reads skills in place from root directories, in this order: configured Atomic project directory (default `.atomic-agent/skills`), `.agents/skills`, `.claude/skills`, `.cursor/skills`, `.pi/skills`, then global Atomic skills. It does not scan nested packages or other agents' home directories. Each `manifest.name` has one selected entry. Different copies produce shadowing diagnostics; identical copies do not duplicate the catalog. Body, references and scripts resolve from that selected source directory.

Ordinary `SKILL.md` requires a name and description; version is optional. In `.claude/skills` the folder name supplies an omitted name. Cloud compatibility accepts one-character names. `disable-model-invocation: true` keeps a skill visible to the operator with a reason but excludes it from model discovery and special skill tools. `allowed-tools` grants no permissions. Hooks, commands, argument substitution, command expansion and foreign subagents are not implemented.

The model receives descriptions first, without the local catalog quota; the complete cloud request is checked against its context window. `skill.view` loads the body with its source directory. Loaded cloud state is reconciled before each step: body edits refresh, disappearance/disable/source change deactivate. A new source needs another view. Repeated-load shortcuts also check the current source and fingerprint. The [runtime workspace contract](../../runtime/docs/cloud-workspace.md) describes instruction discovery and persistence.

Discovery is bounded to 4,096 skill-directory entries, 1 MiB per manifest and 8 MiB total manifest content. Invalid manifests and external project symlinks yield diagnostics. Exceeding the aggregate scan/content limits fails preparation. Project files are never installed or copied as part of discovery.

## Disable scopes

`skills.disabled` remains the global name denylist. `skills.cloudWorkspaces` contains `{ workingDir, projectSkillsEnabled, disabled }` policies; the command/UI stores canonical real paths in user config, never in the repository. Defaults are project skills on and no disabled names. A global ban wins over a workspace preference. A workspace ban blocks every copy of that name, including its global copy, only in cloud sessions of that workspace.

Turning all project skills off excludes every project source, including Atomic. Global entries remain available and may replace project copies unless that name is individually disabled. Turning project skills back on preserves individual bans. The operator sees effective state, source and reasons; disabled entries are absent from the model catalog.

Cloud tools reread configuration on `skill.view` and `skill.run_script`, and revalidate scripts after approval and immediately before spawning. This also catches edits made by another CLI process or directly in config. Already-running scripts continue. Disabling controls skill activation and its special tools; filesystem permissions remain independent. Project copies of built-in names do not receive the built-in name-based approval exception.

## Commands and TUI

```sh
atomic-agent skill list --workspace /path/to/repo
atomic-agent skill show example --workspace /path/to/repo
atomic-agent skill disable example --workspace /path/to/repo
atomic-agent skill enable example --workspace /path/to/repo
atomic-agent skill project off --workspace /path/to/repo
atomic-agent skill project on --workspace /path/to/repo
atomic-agent skill disable example  # global, including every cloud workspace
atomic-agent skill enable example   # global; workspace bans remain
```

In the cloud Skills panel, `w` toggles the selected skill in this project, `e` toggles globally and `p` toggles all project skills. The clickable controls call the same keyboard handlers. Detail and selected rows display the source path and disabled reasons. Local sessions retain their existing Atomic registry and global controls.

The cloud TUI slash palette includes available skills as `/skill-name`, including before a chat is created. Typing `/skill-name optional request` asks the model to load that skill through `skill.view`; the request text stays plain text. Suggestions, keyboard completion and mouse activation share the selected session catalog, and invocation rechecks live policy. Built-in command names and aliases take priority over skill names. Disabled skills remain in the Skills panel with their reasons and have no slash entry.
