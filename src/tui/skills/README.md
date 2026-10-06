# Skills UI

Status: current
Owner: src/tui/skills/

This feature displays installed skills, enable/disable state and the hub catalog. Read [TUI instructions](../AGENTS.md), [skills instructions](../../skills/AGENTS.md) and [config instructions](../../config/AGENTS.md) for changes to installation or persistence. SkillRegistry and the skills domain own discovery, manifest validation, staged files and installation. Views do not own those resources.

## Presentation and input

[SkillsPanel](skills-panel.tsx) is composed by [DebugPane](../components/debug-pane.tsx). It gives install confirmation precedence over remove confirmation, then hub card/hub list, then installed list/detail. Adjacent views are [installed list](skills-list.tsx), [detail](skills-detail.tsx), [hub list](skills-hub-list.tsx), [hub card](skills-hub-card.tsx), [install confirmation](skills-install-confirm.tsx) and [remove confirmation](skills-remove-confirm.tsx). Preserve identifiers anchored in confirmation state, card body/error, scroll and busy/error presentation.

[State](skills-panel-state.ts), [actions](skills-actions.ts), [reducer](skills-reducer.ts), [keys](skills-key-bindings.ts), [filter](skills-filter.ts) and [summary](skills-summary.ts) own pure projection and input transitions. Global precedence remains with TuiApp/app keys. The installed list includes disabled skills via listAll; disabling removes discovery/catalog exposure without deleting installed files. Built-in tools remain separate from optional skill playbooks.

## Operations and resources

[SkillsOrchestrator](skills-orchestrator.ts) owns its refresh timer (default five seconds), GitHub catalog cache, ClawHub client and map of staged installs. It reads runtime registry state, persists disabled names through config, applies registry changes and refreshes runtime catalog consumers. Removal is scoped to the global skills directory; project-only skills are rejected by the existing operation.

The hub combines ClawHub and configured GitHub taps, retaining partial results/errors. Card preview fetches the ClawHub body; GitHub cards explain that the body is fetched at installation. The domain scan/stage/commit/discard functions own installation: a clean scan currently commits immediately; other verdicts enter the existing operator confirmation. Preserve this policy rather than making the view a second installer.

shutdown clears the refresh interval, starts discard for pending staged handles, clears the map and drops catalog/client references. It does not await all discard work or add cancellation for every network request. Relocation does not claim new request-lifetime guarantees. See [domain guide](../../skills/README.md) and [format](../../skills/docs/skill-format.md) for contracts.

## Checks

Run `npx vitest run src/tui/skills src/tui/import src/tui/onboarding/import-step.test.ts src/tui/onboarding/onboarding-import-flow.test.ts src/tui/onboarding/use-onboarding-lifecycle-import.test.tsx src/tui/app-key-bindings.test.ts src/tui/tui-app.test.tsx src/tui/components/debug-pane-budget.test.ts`, then `npm run lint`, `npm run typecheck:tests`, `npm run imports:check` and `npm run docs:check`. Use full `npm run test:ci` for acceptance.

Four adjacent suites cover keys, reducer, filtering and summary projection, including portions of hub/card and confirmation state. Dedicated skills component/orchestrator suites are absent; these tests do not prove live registry installation/removal, network cancellation or every rendered modal interaction. Existing test-type debt remains explicit; production lint alone does not validate fixtures.
