# Skill installation and discovery

Status: current
Owner: src/skills/

This area owns skill installation and discovery. Read [AGENTS.md](AGENTS.md) before changing it.

## Entry points

- [skill-manifest.ts](skill-manifest.ts)
- [skill-registry.ts](skill-registry.ts)
- [seed-starter-skills.ts](seed-starter-skills.ts)
- [workspace-skills.ts](workspace-skills.ts): cloud source selection and live policy; [cloud workspace skills](docs/cloud-workspace.md).

## Ownership and dependencies

SkillRegistry owns filesystem discovery and disabled-name filtering; skill loaders and tools expose selected content to a session. Starter seeding owns packaged defaults without overwriting installed content. Prompt consumes the catalog and loaded skills, while runtime refreshes it; scripts own release-time copying.

## Task-specific reading

Read docs/skill-format.md for format/install changes; ../prompt/AGENTS.md for catalog rendering.

## Validation

`npx vitest run src/skills`; `npm run lint`; `npm run docs:check`. The production typecheck excludes tests; see [development checks](../../docs/development.md).
