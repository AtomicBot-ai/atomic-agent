# Skill installation and discovery

Scope: `src/skills/`. Inherit the root instructions; read [README.md](README.md) to locate the implementation.

## Constraints

- Preserve manifest validation, platform filtering, installed files and disabled-name filtering. Disabled skills disappear from discovery without deleting their directories.
- Keep catalog descriptions in the prefix and loaded bodies in session tail. Changing enabled/catalog contents invalidates the stable prefix deliberately.
- Script execution keeps its approval policy; starter seeding must remain idempotent.

## Read when relevant

Read docs/skill-format.md for format/install changes; ../prompt/AGENTS.md for catalog rendering.

## Checks

Run `npx vitest run src/skills` for affected behavior and `npm run lint`. For documentation run `npm run docs:check`. Use narrower existing test files for a small change; cross-domain contracts require their seam tests.
