# Hooks

Scope: `src/hooks/`. Inherit the root instructions; read [README.md](README.md) to locate the implementation.

## Constraints

- Hooks only tighten: a hook may refuse a call or ask the user, never skip the approval gate.
- A hook command runs with `buildCommandEnv` (no provider keys or other secrets) and always under a timeout; a hanging or crashing hook never blocks or hangs a turn.
- Plugin hooks run only when the plugin record has `runsCodeAccepted === true`, and respect `disabledParts` (`hook:<Event>`).
- User hooks live in `<stateDir>/hooks.json`, not in config.json.
- A broken hooks file or entry becomes a diagnostic, never an exception.
- Keep the executor seam to one wrapper (`runWithToolHooks`); approval logic stays in `src/approval/`.

## Checks

Run `npx vitest run src/hooks src/agent/dispatch` and `npm run lint`. For documentation run `npm run docs:check`.
