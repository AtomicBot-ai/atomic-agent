# Goal mode

Status: current
Owner: src/agent/goal/

Read [agent instructions](../AGENTS.md) and the [module route](../README.md). Entry: [goal-controller.ts](goal-controller.ts).

Goal mode (ATO-451) keeps a chat working, round after round, until an acceptance list is green. `RunTurnOptions.goal` carries the spec: `criteria` (the list the judge reads), optional shell `checks` that must exit 0, and `maxRounds` (default 10, at most 50). The loop itself does not read it; the runtime wraps ordinary turns in the controller ([runtime-goal.ts](../../runtime/composition/runtime-goal.ts)).

After a round that ended with an ordinary answer, the controller runs the checks first. A failing check skips the judge and its trimmed output becomes the next round's message. When the checks pass, one judge call on the active model answers met / not met / blocked per criterion as JSON ([goal-judge.ts](goal-judge.ts)); open items with their reasons start the next round ([goal-messages.ts](goal-messages.ts)). All met ends the goal as `complete`; any blocked item stops it as `blocked` with what is needed from the person.

Every exit is bounded: the round limit and the turn's time ceiling (`budget_limited`), a stopped, failed or ceiling-ended round, a closed session, and three unreadable or failed judge replies in a row (`paused`; a broken judge never loops). The operator's `/goal pause` and `/goal clear` land between rounds through `runtime.controlGoal`.

The goal is stored in `session.metadata.goal` ([goal-state.ts](goal-state.ts)): status, per-criterion marks and reasons, checks, rounds used, judge failures and the last verdict. It survives a restart; a malformed value reads as no goal. Resuming the same list keeps the marks and starts a used-up round budget over.

Checks: `npx vitest run src/agent/goal src/runtime/composition src/tui/commands src/tui/goal`; `npm run lint`.
