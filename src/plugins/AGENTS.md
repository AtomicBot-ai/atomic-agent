# Plugins

Scope: `src/plugins/`. Inherit the root instructions; read [README.md](README.md) to locate the implementation.

## Constraints

- Reading, staging or installing a plugin never runs its code. Anything that can run a command (hooks, stdio MCP servers, skill scripts) is reported by `bundleRunsCode` and needs the user's consent where it is wired in.
- Every path a manifest names must resolve inside the plugin folder. Staging drops symlinks.
- A plugin never grants itself trust: its MCP servers stay `approval_gated`, `allowed-tools` style fields are hints only, and its skills cannot shadow a skill the user installed directly.
- A broken plugin degrades to a diagnostic; it must not stop the agent from starting.
- Plugin state lives in `<stateDir>/plugins/plugins.json`, not in config.json.

## Checks

Run `npx vitest run src/plugins src/skills` and `npm run lint`. For documentation run `npm run docs:check`.
