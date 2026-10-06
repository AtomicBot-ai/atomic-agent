# Local model management UI

Status: current
Owner: src/tui/local-models/

This feature owns local-model selection, status projection and TUI orchestration. Read [TUI instructions](../AGENTS.md) and [local-llm instructions](../../local-llm/AGENTS.md) for underlying downloads/server operations; persistence follows [config instructions](../../config/AGENTS.md). Moving UI does not move the model/server assets or their processes into the view layer.

## Presentation and transitions

[LocalModelsPanel and LocalModelDetail](local-models-panel.tsx) render chat/embedding rows, availability, daemon status and detail with measured row windows. [Panel state](local-models-panel-state.ts), [actions](local-models-actions.ts), [reducer](local-models-reducer.ts), [keys](local-models-key-bindings.ts) and [HF keys](local-models-hf-keys.ts) own the corresponding state/input. LLM panel and DebugPane compose these views; LLM primary actions retain activation/preflight rather than creating a second switching path.

[Hugging Face branch](local-models-hf-branch.tsx) binds local state/actions to [reference editor](hf-reference-editor.tsx) and [pick list](hf-pick-list.tsx). Onboarding deliberately reuses these specialized views via callbacks, including hfChoiceLine/windowHfChoices and measurement constants. They do not import onboarding or either flow's state/key table; the pick list does depend on local-llm repo types and RAM warning policy, so it is not a generic domain-free primitive. The reference editor uses shared MultiLineEditor/mouse/theme. RAM warnings inform selection without forbidding it; hidden choices/mmproj messaging remain part of the view contract.

[Notification prompt](notify-prompt-box.tsx) renders the selected notification route and real pull progress; [notification keys](local-models-notify-keys.ts) and [persistence](persist-download-notify.ts) handle the choice. [DownloadChip](download-chip.tsx) projects pull/worker waiting state into StatusBar's one-row budget, shedding ETA/bar/label or disappearing when needed. It does not own a download. Shared [transfer rate](../hooks/use-transfer-rate.ts) also serves onboarding progress and the local-turn gate.

[Log view](local-llm-logs-panel.tsx) renders [log state](local-llm-logs-state.ts). It takes a bounded tail, while the orchestrator reads/polls the file only through its existing start/stop log-refresh path. Keeping this view here aligns it with its reducer/state; the distinct log state cadence is preserved.

## Operations and resources

[LocalModelsOrchestrator](local-models-orchestrator.ts) projects catalog/download/daemon state and binds UI requests to local-llm operations. It owns refresh/log timers, download watches and supervisor interaction. Shutdown detaches watches so background workers continue, clears timers and stops only its supervised daemon under existing stopOnExit/other-live-session conditions. [Supervisor](daemon-supervisor.ts), [wedge watch](daemon-wedge-watch.ts), [port clearance](local-models-port-clearance.ts) and [restart seam](local-models-daemon-restart.ts) remain unchanged.

The local HF lookup owns its AbortController/identity guard and explicit Escape cancellation. This move does not change shutdown behavior or prove every request lifetime is covered. Catalog writes and paired downloads still use local-llm; validated config writes/cache invalidation use the existing [shared TUI config helper](../persist-user-local-models-config.ts). That helper and [backend readiness](../local-backend-readiness.ts) are used by several flows/commands and remain outside this feature. CLI/domain operations must follow their domain owners, not import a view.

## Checks

Run `npx vitest run src/tui/local-models src/tui/llm-panel src/tui/onboarding src/tui/providers src/tui/components/manage-panel-fit.test.tsx src/tui/components/status-bar.test.tsx src/tui/components/debug-pane-budget.test.ts` for view consumers, widths, local activation, provider seams and orchestration. Existing daemon-wedge-watch fixtures need a local loopback HTTP listener; sandbox EPERM is not a behavioral pass. Run `npm run lint`, `npm run typecheck:tests`, `npm run imports:check`, `npm run docs:check` and full `npm run test:ci`.

Source and dedicated notification/chip tests are adjacent. Local panel/HF branch/log view do not yet have individual component suites; existing measured-panel, LLM app, onboarding HF/mouse, reducer and orchestration tests cover portions of their composition. No exhaustive visual/platform or actual download/server verification is implied. Existing local-models test-type debt remains recorded separately from production lint.
