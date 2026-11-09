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
- [marketplace-manifest.ts](marketplace-manifest.ts): reads `.claude-plugin/marketplace.json` (and `.omp-plugin/`), each entry's source kind, and the git URL allowlist.
- [marketplace-fetch.ts](marketplace-fetch.ts): `PluginFetcher`, the only network code: shallow `git` checkout with hooks off, and https download of a bare marketplace.json.
- [marketplace-store.ts](marketplace-store.ts): lock file `<stateDir>/plugins/marketplaces.json` (source, ref, pinned commit, fetch time) and checkouts in `plugins/marketplaces/<name>/`.
- [marketplace.ts](marketplace.ts): marketplace add / list / update / remove, `plugin install name@marketplace`, `plugin update`. Installs go fetch, stage, `review`, commit (`reviewAndCommit` in plugin-install.ts).
- [plugin-permissions.ts](plugin-permissions.ts): what a plugin would run (hooks, local MCP commands, scripts), `diffPluginPermissions` between two versions, consent id.
- [plugin-install-review.ts](plugin-install-review.ts): the review every install and update runs: security scan, permission diff, runs-code consent. See [docs/install-safety.md](docs/install-safety.md).
- CLI: `atomic-agent plugin` in [../cli/plugin-command.ts](../cli/plugin-command.ts). Marketplaces: [docs/marketplaces.md](docs/marketplaces.md).

## Ownership and dependencies

Skills from plugins are loaded by [../skills/skill-loader.ts](../skills/skill-loader.ts) and [../skills/workspace-skills.ts](../skills/workspace-skills.ts) through a `pluginSkills` callback, as user-installed skills named `plugin:skill`. The terminal slash palette lists plugin commands through `tui/skills/skills-orchestrator.ts` and sends the rendered text as the user's message. The runtime adds plugin MCP servers next to the user's own in `runtime/composition/runtime-tool-catalog.ts`; they start with the agent, so a newly enabled plugin's servers need a restart. Format details: [docs/plugin-format.md](docs/plugin-format.md).

## Validation

`npx vitest run src/plugins src/skills`; `npm run lint`; `npm run docs:check`.
