# Plugins (Claude-format packages)

Status: current
Owner: src/plugins/

A plugin is a folder that bundles skills, slash commands, subagent profiles, hooks and MCP servers, in the format Claude Code plugins use (also Codex, Cursor and Agent Plugins manifests). Read [AGENTS.md](AGENTS.md) before changing it.

## Entry points

- [plugin-manifest.ts](plugin-manifest.ts): detects the format and validates the manifest; paths may not leave the plugin.
- [plugin-bundle.ts](plugin-bundle.ts): lists what a plugin ships, without running anything; `bundleRunsCode` says whether enabling it can run commands.
- [plugin-install.ts](plugin-install.ts): stage (copy, drop symlinks), commit, remove, enable/disable a plugin or one of its parts.
- [plugin-store.ts](plugin-store.ts): `<stateDir>/plugins/plugins.json`, shared by the terminal and the desktop.
- [plugin-runtime.ts](plugin-runtime.ts): enabled plugins parsed and cached; skill folders for the skill loaders.
- [plugin-mcp.ts](plugin-mcp.ts): plugin MCP servers for the runtime catalog, named `<plugin>-<server>`. A plugin's own `trust` is dropped, and local (stdio) servers start only after `plugin allow-code`.
- [plugin-subagents.ts](plugin-subagents.ts): `agents/*.md` profiles, listed for Fusion worker profiles; nothing runs them yet.
- [plugin-commands.ts](plugin-commands.ts): `commands/**/*.md` as slash commands `/plugin:command`; renders `$ARGUMENTS`, `$1`..`$9` and `${CLAUDE_PLUGIN_ROOT}`, never runs anything.
- CLI: `atomic-agent plugin` in [../cli/plugin-command.ts](../cli/plugin-command.ts).

## Ownership and dependencies

Skills from plugins are loaded by [../skills/skill-loader.ts](../skills/skill-loader.ts) and [../skills/workspace-skills.ts](../skills/workspace-skills.ts) through a `pluginSkills` callback, as user-installed skills named `plugin:skill`. The terminal slash palette lists plugin commands through `tui/skills/skills-orchestrator.ts` and sends the rendered text as the user's message. The runtime adds plugin MCP servers next to the user's own in `runtime/composition/runtime-tool-catalog.ts`; they start with the agent, so a newly enabled plugin's servers need a restart. Format details: [docs/plugin-format.md](docs/plugin-format.md).

## Validation

`npx vitest run src/plugins src/skills`; `npm run lint`; `npm run docs:check`.
