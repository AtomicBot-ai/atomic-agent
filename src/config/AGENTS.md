# Configuration and compatibility

Scope: `src/config/`. Inherit the root instructions; read [README.md](README.md) to locate the implementation.

## Constraints

- Read config-schema.ts defaults and load-config.ts precedence before adding an environment setting. Stored config is versioned; preserve old-file parsing and migration tests.
- Changing a default is a behavior change. Do not copy defaults from archived documentation or bump versions for documentation-only edits.
- Preserve owner-only credential storage, cache reset after writes and model/provider validation. Never print credentials in validation notices.
- The getConfig cache is the explicit singleton exception; avoid adding hidden mutable globals.

## Read when relevant

Read docs/compatibility.md for schema/default/migration changes and ../approval/AGENTS.md for approval settings.

## Checks

Run `npx vitest run src/config` for affected behavior and `npm run lint`. For documentation run `npm run docs:check`. Use narrower existing test files for a small change; cross-domain contracts require their seam tests.
