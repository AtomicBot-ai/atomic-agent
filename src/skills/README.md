# Skill installation and discovery

Status: current
Owner: src/skills/

This area owns skill installation and discovery. Read [AGENTS.md](AGENTS.md) before changing it.

## Entry points

- [skill-manifest.ts](skill-manifest.ts)
- [skill-registry.ts](skill-registry.ts)
- [seed-starter-skills.ts](seed-starter-skills.ts)
- [workspace-skills.ts](workspace-skills.ts): cloud source selection and live policy; [cloud workspace skills](docs/cloud-workspace.md).
- [shared-skills-dir.ts](shared-skills-dir.ts): the shared `~/.agents/skills` folder other agents and `npx skills` install into; local and cloud discovery read it with the lowest priority.
- [clawhub/skill-updates.ts](clawhub/skill-updates.ts): `skill update` for GitHub-tap and ClawHub installs; [hub/skill-lock.ts](hub/skill-lock.ts) records each install's source, scanned version and file digest ([hub skill lock and updates](docs/skill-format.md#hub-skill-lock-and-updates)).
- [project-trust.ts](project-trust.ts): project skills and instruction files load only after the operator trusted the folder; [project folder trust](docs/project-trust.md).
- Plugin skills: installed plugins ([../plugins/README.md](../plugins/README.md)) contribute skill folders through the `pluginSkills` option; they load as user-installed skills named `plugin:skill`.
- [eval/](eval/README.md): Skill Lab, `skill eval` runs tasks with and without a skill and saves the comparison under `<stateDir>/skill-evals/`.
- [curator/](curator/index.ts): skill usage ledger, version snapshots and change log, and the curator that archives unused agent-learned skills (ATO-580); [history and curator](docs/skill-format.md#history-usage-and-the-curator).
- [learning/](learning/index.ts): self-learning (ATO-67), the background experience review after a long turn, the learned-skill linter, the "Learned" journal and `/learn undo`, drafts pending review (`pending-drafts.ts`, `/learn approve|discard`); [self-learning](docs/skill-format.md#self-learning).
- [skill-script-runner.ts](skill-script-runner.ts): runs a declared script with the same filtered environment as a shell command (`buildCommandEnv` plus `tools.shell.envPassthrough`), so provider keys loaded from `.env` do not reach it.

Organization policy (ATO-587): `prepareSkillInstall` refuses a skill the admin policy denies (`SkillInstallError` code `policy_denied`, HTTP 403), and `SkillRegistry` takes an `isBlocked` predicate that keeps such a skill out like a disabled one (`listAll` marks it `blocked`). See [../policy/README.md](../policy/README.md).

## Ownership and dependencies

SkillRegistry owns filesystem discovery and disabled-name filtering; skill loaders and tools expose selected content to a session. Starter seeding owns packaged defaults without overwriting installed content. Prompt consumes the catalog and loaded skills, while runtime refreshes it; scripts own release-time copying.

## Task-specific reading

Read docs/skill-format.md for format/install changes; ../prompt/AGENTS.md for catalog rendering.

## Validation

`npx vitest run src/skills`; `npm run lint`; `npm run docs:check`. The production typecheck excludes tests; see [development checks](../../docs/development.md).
