# Fusion workers

Status: current
Owner: src/tools/fusion/

Fusion delegates bounded task waves to worker turns. Contracts carry deliverables, declared inputs and dependencies; completed providers order later waves even when their task failed. Preserve task status attribution and hand-back based on completed-step progress rather than an independent timer.

Workers are ephemeral: no durable session row/reflection/trace; no recursive delegation or invisible interactive approval. Provider pins must not fall over to a different billing/model leg. Declared input replacement remains forbidden. Concurrency is resolved from the call, task count and serving slot capability, rather than blindly capturing startup state.

Read [tool instructions](../AGENTS.md), [worker runner](worker-runner.ts), [worker policy](worker-tool-policy.ts), [delegate](fusion-delegate.ts), [wave planning](contract-waves.ts), [input contract](contract-inputs.ts), and [run modes](../../llm/run-mode/README.md). Run tools/fusion and runtime fusion seam tests.
