# Skill installation and discovery

Status: current
Owner: src/skills/

This area owns skill installation and discovery. Read [AGENTS.md](AGENTS.md) before changing it.

## Entry points

- [skill-manifest.ts](skill-manifest.ts)
- [skill-registry.ts](skill-registry.ts)
- [seed-starter-skills.ts](seed-starter-skills.ts)
- [workspace-skills.ts](workspace-skills.ts): cloud source selection and live policy; [cloud workspace skills](docs/cloud-workspace.md).
- [clawhub/skill-updates.ts](clawhub/skill-updates.ts): `skill update` for GitHub-tap and ClawHub installs; [hub/skill-lock.ts](hub/skill-lock.ts) records each install's source, scanned version and file digest ([hub skill lock and updates](docs/skill-format.md#hub-skill-lock-and-updates)).
- [project-trust.ts](project-trust.ts): project skills and instruction files load only after the operator trusted the folder; [project folder trust](docs/project-trust.md).
- Plugin skills: installed plugins ([../plugins/README.md](../plugins/README.md)) contribute skill folders through the `pluginSkills` option; they load as user-installed skills named `plugin:skill`.
- [skill-script-runner.ts](skill-script-runner.ts): runs a declared script with the same filtered environment as a shell command (`buildCommandEnv` plus `tools.shell.envPassthrough`), so provider keys loaded from `.env` do not reach it.

## Ownership and dependencies

SkillRegistry owns filesystem discovery and disabled-name filtering; skill loaders and tools expose selected content to a session. Starter seeding owns packaged defaults without overwriting installed content. Prompt consumes the catalog and loaded skills, while runtime refreshes it; scripts own release-time copying.

## Task-specific reading

Read docs/skill-format.md for format/install changes; ../prompt/AGENTS.md for catalog rendering.

## Validation

`npx vitest run src/skills`; `npm run lint`; `npm run docs:check`. The production typecheck excludes tests; see [development checks](../../docs/development.md).
