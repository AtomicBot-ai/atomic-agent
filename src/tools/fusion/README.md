# Fusion workers

Status: current
Owner: src/tools/fusion/

Fusion delegates bounded task waves to worker turns. Contracts carry deliverables, declared inputs and dependencies; completed providers order later waves even when their task failed. Preserve task status attribution and hand-back based on completed-step progress rather than an independent timer.

Workers are ephemeral: no durable session row/reflection/trace; no recursive delegation or invisible interactive approval. Provider pins must not fall over to a different billing/model leg. Declared input replacement remains forbidden. Concurrency is resolved from the call, task count and serving slot capability, rather than blindly capturing startup state.

Read [tool instructions](../AGENTS.md), [worker runner](worker-runner.ts), [worker policy](worker-tool-policy.ts), [delegate](fusion-delegate.ts), [wave planning](contract-waves.ts), [input contract](contract-inputs.ts), and [run modes](../../llm/run-mode/README.md). Run tools/fusion and runtime fusion seam tests.

## Behavior acceptance (PR #605 proposal)

A shared `provides.shape` carries field meaning to producers and consumers, but is guidance, not proof. For executable semantics, derive named `contract.checks` from the operator's request and assert the boundary using the existing `contract.checks -> runChecks -> verify.run` path. The #491 world/local-coordinate regression exercises that real isolated runner; merely finding a symbol or observing no console error is insufficient.

`llm.runMode.fusion.requireBehaviorChecklist` is opt-in and read live on every delegation. Omitted/false permits fan-outs without named checks; true requires a nonempty named checklist. No declared checks means no checklist PASS claim. This default is a proposal pending the maintainers' decision, not agreed upstream policy.

Declared checks remain enforced in either setting. Their full verdict lists every item as PASS, FAIL or UNCHECKED. Malformed or rejected declarations cannot shed captured names, executable values or valid task bindings during repair; missing fields may be filled without replacing captured values. Once validated, the exact complete checklist stays pinned throughout the operator turn, including after PASS. Every repair reruns all items, including previous passes; three failed full-checklist rounds stop further delegation. Turning the option off can clear a missing-check policy refusal after an optional successful fan-out, never a failed declared check.

A blocked terminal appends the authoritative verdict to the original reply/finish summary, preserves other arguments (including attachments), and leaves the runtime failed. A passed declared checklist appends its PASS verdict. The maintainers are still considering failure enforcement, the three-round bound and PASS presentation when the flag is off; this follow-up does not change that policy.

The [Fusion guidance](../../prompt/fusion-guidance.ts) applies to every Fusion user: never stop at the plan, and delegate inadequate work again with what was wrong and what good looks like. Declared output paths retain their one-time operator approval. Model/vision judgments and a separate clean-context verifier from #539 are not implemented here.

Regression coverage: [boundary/checklist checks](contract-checks.test.ts), [delegation](fusion-delegate.test.ts), [terminal behavior](../../agent/fusion-checklist-terminal.test.ts), [turn identity](../../runtime/composition/runtime-turn-service.test.ts), and [guidance budgets](../../prompt/fusion-guidance.test.ts). The five-scene tests are derived from the published specifications/failure classes, not byte-identical replays of unpublished builds. H30/H60 model runs are separate evidence and not claims of improvement from this PR.
